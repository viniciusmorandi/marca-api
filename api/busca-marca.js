import axios from 'axios';

// ============================================================================
// HELPERS: Normalização e Verificação de Situações Permissivas
// ============================================================================

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
 * Qualquer situação fora desta lista = INDISPONÍVEL
 */
function isPermissive(situacao) {
  const s = normalize(situacao);
  const allowlist = [
    'indeferida', 'indeferido',
    'negada', 'negado',
    'arquivada', 'arquivamento',
    'extinta', 'extinto',
    'caducada', 'caducado',
    'cancelada', 'cancelado',
    'nulidade procedente', 'nulo',
    'renuncia', 'renúncia'
  ];
  return allowlist.some(term => s.includes(term));
}

// ============================================================================
// CONSULTA INPI (Infosimples)
// ============================================================================

/**
 * Consulta INPI via Infosimples com busca EXATA
 * @throws Em caso de erro de rede, timeout ou resposta inválida
 */
async function consultarINPI(marca) {
  const token = process.env.INFOSIMPLES_TOKEN;
  
  if (!token) {
    throw new Error('Token Infosimples não configurado');
  }

  const url = 'https://api.infosimples.com/api/v2/consultas/inpi/marcas';
  
  // SEMPRE E SÓ EXATA - nunca radical
  const body = {
    marca: marca,
    tipo: 'exata',
    token: token
  };

  const config = {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000 // 10 segundos
  };

  try {
    const response = await axios.post(url, body, config);
    return response.data;
  } catch (error) {
    // Log seguro - sem expor token
    console.error('Erro ao consultar INPI:', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText
    });
    throw error;
  }
}

// ============================================================================
// LÓGICA DE DECISÃO
// ============================================================================

/**
 * Decide disponibilidade com base nos processos retornados
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
  const todasPermissivas = matchesExatos.every(p => isPermissive(p.situacao));

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

// ============================================================================
// HANDLER PRINCIPAL (Vercel Serverless Function)
// ============================================================================

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

  if (req.method !== 'POST') {
    return res.status(405).json({ 
      error: 'Método não permitido',
      message: 'Use POST para consultar marcas' 
    });
  }

  // ========== VALIDAÇÃO ==========
  const { marca } = req.body;

  if (!marca || typeof marca !== 'string' || marca.trim() === '') {
    return res.status(422).json({
      error: 'Validação falhou',
      message: 'Campo "marca" é obrigatório e deve ser uma string não vazia',
      campo: 'marca'
    });
  }

  const marcaTrimmed = marca.trim();

  try {
    // ========== CONSULTA INPI ==========
    const resultado = await consultarINPI(marcaTrimmed);
    const processos = resultado.processos || [];

    // ========== DECISÃO ==========
    const decisao = decidirDisponibilidade(marcaTrimmed, processos);

    // ========== RESPOSTA ==========
    const elapsedMs = Date.now() - startTime;
    
    // Log estruturado (sem token)
    console.log(JSON.stringify({
      method: req.method,
      path: req.url,
      marca: marcaTrimmed,
      qtd_processos: processos.length,
      qtd_matches_exatos: decisao.processos.length,
      disponivel: decisao.disponivel,
      elapsed_ms: elapsedMs,
      status: 200
    }));

    return res.status(200).json({
      marca: marcaTrimmed,
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
      processos: decisao.processos,
      metadata: {
        fonte: 'INPI via Infosimples',
        timestamp: new Date().toISOString(),
        elapsed_ms: elapsedMs
      }
    });

  } catch (error) {
    const elapsedMs = Date.now() - startTime;

    // ========== TRATAMENTO DE ERROS ==========
    
    // Erro de validação upstream (400)
    if (error.response?.status === 400) {
      console.error(JSON.stringify({
        method: req.method,
        path: req.url,
        marca: marcaTrimmed,
        error: 'Infosimples retornou 400',
        details: error.response?.data,
        elapsed_ms: elapsedMs,
        status: 502
      }));

      return res.status(502).json({
        error: 'Erro ao consultar INPI',
        message: 'Serviço de consulta retornou erro de validação',
        details: error.response?.data?.message || 'Erro desconhecido'
      });
    }

    // Erro de upstream (5xx, timeout, rede)
    console.error(JSON.stringify({
      method: req.method,
      path: req.url,
      marca: marcaTrimmed,
      error: error.message,
      status_upstream: error.response?.status,
      elapsed_ms: elapsedMs,
      status: 502
    }));

    return res.status(502).json({
      error: 'Erro ao consultar INPI',
      message: 'Serviço de consulta temporariamente indisponível',
      details: error.code === 'ECONNABORTED' ? 'Timeout' : error.message
    });
  }
}
