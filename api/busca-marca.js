import axios from 'axios';

/* ============================================================================
 * Helpers de normalização e decisão
 * ========================================================================== */
const normalize = (s = '') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Stems de situações TERMINAIS (qualquer outra => INDISPONÍVEL) */
const TERMINAIS_STEMS = [
  'indeferid',            // indeferida/indeferido
  'negad',                // negada/negado
  'arquiv',               // arquivada/arquivado/arquivamento
  'extint',               // extinta/extinto/registro de marca extinto
  'caducad',              // caducada/caducado
  'cancelad',             // cancelada/cancelado
  'nulidade procedent',   // nulidade procedente
  'nulo',                 // nulo
  'renunci'               // renúncia/renuncia (total)
];

/** true se a situação é terminal (permite novo registro) */
const situacaoPermite = (situacao = '') => {
  const s = normalize(situacao);
  return TERMINAIS_STEMS.some(stem => s.includes(stem));
};

/** Extrai todos os processos de um resultado Infosimples (data = array de blocos) */
const extrairProcessos = (resultado) => {
  if (!resultado || !Array.isArray(resultado.data)) return [];
  return resultado.data.flatMap(b => (Array.isArray(b.processos) ? b.processos : []));
};

/** Aplica a regra simplificada de disponibilidade */
function decidirDisponibilidade(marcaDigitada, processos) {
  // (1) Sem processos => disponível
  if (!Array.isArray(processos) || processos.length === 0) {
    return {
      disponivel: true,
      motivo: 'Nenhum registro encontrado (busca exata)',
      processos: []
    };
  }

  // (2) Considera apenas matches EXATOS do nome (comparação normalizada)
  const alvo = normalize(marcaDigitada);
  const exatos = processos.filter(p => normalize(p.marca || '') === alvo);

  // Sem match exato => disponível
  if (exatos.length === 0) {
    return {
      disponivel: true,
      motivo: 'Nenhum registro exato encontrado',
      processos: []
    };
  }

  // (3) Só permite se TODAS as situações forem terminais
  const todasTerminais = exatos.every(p =>
    situacaoPermite(p.situacao || p.situacao_processual || p.status || '')
  );

  if (todasTerminais) {
    return {
      disponivel: true,
      motivo: 'Somente situações terminais (permite novo registro)',
      processos: exatos.map(p => ({
        numero: p.numero,
        situacao: p.situacao || p.situacao_processual || p.status || '',
        titular: p.titular,
        classe: p.classe
      }))
    };
  }

  // Qualquer outra situação (inclui Alto Renome, registro em vigor, em exame, publicada, sobrestado etc.) => indisponível
  return {
    disponivel: false,
    motivo: 'Há situação(ões) não-terminais (registro ativo, Alto Renome, exame, publicação, sobrestamento, etc.)',
    processos: exatos.map(p => ({
      numero: p.numero,
      situacao: p.situacao || p.situacao_processual || p.status || '',
      titular: p.titular,
      classe: p.classe
    }))
  };
}

/* ============================================================================
 * Consulta ao INPI via Infosimples — com paginação (sempre tipo=exata)
 * ========================================================================== */
async function consultarINPI_TodasPaginas(marca) {
  const token = process.env.INFOSIMPLES_TOKEN;
  if (!token) {
    const e = new Error('Token Infosimples não configurado');
    e.code = 'CONFIG';
    throw e;
  }

  const url = 'https://api.infosimples.com/api/v2/consultas/inpi/marcas';

  const coletarPagina = async (pagina = 1) => {
    const { data } = await axios.post(
      url,
      { token, marca, tipo: 'exata', pagina }, // SEMPRE e SÓ EXATA
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return data; // objeto com { code, code_message, data: [{ processos, total_paginas, ... }], ... }
  };

  // Página 1
  const first = await coletarPagina(1);

  // ⚠️ Se o serviço está instável (ex.: code=600), trate como erro upstream
  if (first?.code && first.code !== 200) {
    const e = new Error(`Infosimples retornou erro (${first.code}): ${first.code_message || 'indisponível'}`);
    e.code = 'UPSTREAM';
    e.upstream = first;
    throw e;
  }

  let blocos = Array.isArray(first?.data) ? [...first.data] : [];
  const totalPaginas =
    first?.data?.[0]?.total_paginas ??
    first?.total_paginas ??
    1;

  // Demais páginas (se houver)
  for (let p = 2; p <= totalPaginas; p++) {
    const page = await coletarPagina(p);

    if (page?.code && page.code !== 200) {
      const e = new Error(`Infosimples erro na página ${p} (${page.code}): ${page.code_message || 'indisponível'}`);
      e.code = 'UPSTREAM';
      e.upstream = page;
      throw e;
    }

    if (Array.isArray(page?.data)) {
      blocos = blocos.concat(page.data);
    }
  }

  return { data: blocos, header: first?.header || null, code: 200 };
}

/* ============================================================================
 * Handler (Serverless / Vercel)
 * ========================================================================== */
export default async function handler(req, res) {
  const t0 = Date.now();

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Método
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido', mensagem: 'Use POST para consultar marcas' });
  }

  // Validação básica
  const { marca } = req.body || {};
  if (!marca || typeof marca !== 'string' || marca.trim() === '') {
    return res.status(422).json({
      erro: 'Validação falhou',
      mensagem: 'O campo "marca" é obrigatório e deve ser uma string não vazia'
    });
  }

  const marcaTrimmed = marca.trim();

  try {
    // 1) Consulta paginada (exata)
    const resultado = await consultarINPI_TodasPaginas(marcaTrimmed);

    // 2) Extrai todos os processos (todas as páginas)
    const processos = extrairProcessos(resultado);

    // 3) Decide disponibilidade
    const decisao = decidirDisponibilidade(marcaTrimmed, processos);

    // 4) Resposta
    return res.status(200).json({
      marca: marcaTrimmed,
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
      processos: decisao.processos,
      metadata: {
        fonte: 'INPI',
        tipo_busca: 'exata',
        paginas_coletadas: resultado?.data?.[0]?.total_paginas ?? 1,
        tempo_resposta_ms: Date.now() - t0,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    // Logs essenciais (sem vazar token)
    console.error('ERRO INPI', {
      marca: marcaTrimmed,
      err: error.message,
      code: error.code,
      upstream_code: error.upstream?.code,
      upstream_msg: error.upstream?.code_message
    });

    // Indisponibilidade Infosimples/INPI (ex.: code=600)
    if (error.code === 'UPSTREAM' || error?.response) {
      return res.status(502).json({
        erro: 'Erro ao consultar INPI',
        mensagem: 'Serviço de consulta temporariamente indisponível',
        detalhes: error.upstream?.code_message || error.response?.data?.message || error.message
      });
    }

    // Timeout/rede
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return res.status(504).json({ erro: 'Timeout', mensagem: 'A consulta ao INPI excedeu o tempo limite' });
    }

    // Config ou genérico
    if (error.code === 'CONFIG') {
      return res.status(500).json({ erro: 'Configuração', mensagem: error.message });
    }

    return res.status(500).json({ erro: 'Erro interno', mensagem: 'Falha inesperada ao processar a solicitação' });
  }
}
