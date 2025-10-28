import axios from 'axios';

// ==============================================================================
// HELPERS: Normalização e Verificação de Situações Permissivas
// ==============================================================================

/**
 * Normaliza texto: remove diacríticos/acentos, converte para lowercase e trim
 * Usa NFD (Normalization Form Decomposed) para separar base + diacríticos
 */
function normalize(texto) {
  if (!texto) return '';
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacríticos
    .toLowerCase()
    .trim();
}

/**
 * Verifica se a situação permite novo registro (allowlist)
 * Situações TERMINAIS = marca não está mais ativa/válida = permite registro
 * Qualquer situação fora desta lista = INDISPONÍVEL
 */
function situacaoPermite(situacao) {
  const s = normalize(situacao);
  const TERMINAIS_STEMS = [
    'indeferid',           // indeferida/indeferido
    'negad',               // negada/negado
    'arquiv',              // arquivada/arquivado/arquivamento
    'extint',              // extinta/extinto/registro de marca extinto
    'caducad',             // caducada/caducado
    'cancelad',            // cancelada/cancelado
    'nulidade procedent',  // nulidade procedente
    'nulo',
    'renunci'              // renúncia/renuncia
  ];
  return TERMINAIS_STEMS.some(term => s.includes(term));
}

// ==============================================================================
// CONSULTA INPI (Infosimples)
// ==============================================================================

/**
 * Consulta a API do INPI via Infosimples
 * Sempre usa tipo="exata" (NUNCA radical ou outro)
 * Timeout configurado no axios (10s)
 */
async function consultarINPI(marca) {
  const url = 'https://api.infosimples.com/api/v2/consultas/inpi/marcas';
  
  const requestBody = {
    token: process.env.INFOSIMPLES_TOKEN,
    marca: marca,
    tipo: 'exata'  // SEMPRE E SÓ EXATA - nunca usar radical
  };

  // Timeout no config do axios (3º parâmetro), NÃO no body
  const response = await axios.post(url, requestBody, {
    timeout: 10000
  });

  return response.data;
}

// ==============================================================================
// LÓGICA DE DECISÃO: Disponibilidade da Marca
// ==============================================================================

/**
 * Decide se a marca está disponível com base nas situações retornadas pelo INPI
 * REGRA SIMPLES:
 *  1. Sem processos → DISPONÍVEL
 *  2. Processos mas sem match exato → DISPONÍVEL
 *  3. Match exato → DISPONÍVEL somente se TODAS situações estão em TERMINAIS_STEMS
 *                   Qualquer situação fora da allowlist (incluindo Alto Renome,
 *                   em vigor, em exame, etc.) → INDISPONÍVEL
 */
function decidirDisponibilidade(marca, processos) {
  // Sem processos = DISPONÍVEL
  if (!processos || processos.length === 0) {
    return {
      disponivel: true,
      motivo: 'Nenhum registro encontrado (busca exata)',
      processos: []
    };
  }

  // Filtrar apenas matches exatos (comparação normalizada)
  const marcaNormalizada = normalize(marca);
  const matchesExatos = processos.filter(p =>
    normalize(p.marca) === marcaNormalizada
  );

  // Sem matches exatos = DISPONÍVEL
  if (matchesExatos.length === 0) {
    return {
      disponivel: true,
      motivo: 'Nenhum registro exato encontrado',
      processos: []
    };
  }

  // Com matches exatos: verificar se TODAS as situações são permissivas
  const todasPermissivas = matchesExatos.every(p => situacaoPermite(p.situacao));

  if (todasPermissivas) {
    return {
      disponivel: true,
      motivo: 'Todos os registros encontrados estão em situação que permite novo registro',
      processos: matchesExatos.map(p => ({
        numero: p.numero,
        situacao: p.situacao,
        titular: p.titular,
        classe: p.classe
      }))
    };
  }

  // Pelo menos uma situação não-permissiva = INDISPONÍVEL
  return {
    disponivel: false,
    motivo: 'Marca já registrada ou em processo ativo',
    processos: matchesExatos.map(p => ({
      numero: p.numero,
      situacao: p.situacao,
      titular: p.titular,
      classe: p.classe
    }))
  };
}

// ==============================================================================
// HANDLER PRINCIPAL (Vercel Serverless function)
// ==============================================================================

export default async function handler(req, res) {
  const startTime = Date.now();

  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Validação: apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      erro: 'Método não permitido',
      mensagem: 'Use POST para consultar marcas'
    });
  }

  // Validação: campo "marca" obrigatório
  const { marca } = req.body;
  if (!marca || typeof marca !== 'string' || marca.trim().length === 0) {
    return res.status(422).json({
      erro: 'Validação falhou',
      mensagem: 'O campo "marca" é obrigatório e deve ser uma string não vazia'
    });
  }

  const marcaTrimmed = marca.trim();

  try {
    // Consulta ao INPI (envia exatamente como o usuário digitou)
    const resultado = await consultarINPI(marcaTrimmed);

    // Extrai processos retornados
    const processos = resultado?.data?.processos || [];

    // Decide disponibilidade
    const decisao = decidirDisponibilidade(marcaTrimmed, processos);

    // Resposta final
    return res.status(200).json({
      marca: marcaTrimmed,
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
      processos: decisao.processos,
      metadata: {
        fonte: 'INPI',
        tipo_busca: 'exata',
        timestamp: new Date().toISOString(),
        tempo_resposta_ms: Date.now() - startTime
      }
    });

  } catch (error) {
    console.error('Erro ao consultar INPI:', {
      marca: marcaTrimmed,
      erro: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    // Erro de upstream (INPI/Infosimples indisponível)
    if (error.response) {
      return res.status(502).json({
        erro: 'Erro ao consultar INPI',
        mensagem: 'O serviço de consulta de marcas está temporariamente indisponível',
        detalhes: error.response.data?.message || error.message
      });
    }

    // Timeout ou erro de rede
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return res.status(504).json({
        erro: 'Timeout',
        mensagem: 'A consulta ao INPI demorou muito tempo. Tente novamente.'
      });
    }

    // Erro genérico
    return res.status(500).json({
      erro: 'Erro interno',
      mensagem: 'Ocorreu um erro ao processar sua solicitação'
    });
  }
}
