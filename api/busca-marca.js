import axios from 'axios';

// ============================ Helpers ============================
const normalize = (s='') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

// Situações TERMINAIS (qualquer outra => INDISPONÍVEL)
const TERMINAIS_STEMS = [
  'indeferid', 'negad', 'arquiv', 'extint', 'caducad',
  'cancelad', 'nulidade procedent', 'nulo', 'renunci'
];
const situacaoPermite = (situacao='') => {
  const s = normalize(situacao);
  return TERMINAIS_STEMS.some(stem => s.includes(stem));
};

// Extrai processos do formato Infosimples (data: [{ processos: [...] }, ...])
const extrairProcessos = (resultado) => {
  if (!resultado || !Array.isArray(resultado.data)) return [];
  return resultado.data.flatMap(b => Array.isArray(b.processos) ? b.processos : []);
};

// Decide disponibilidade a partir dos processos (regra simples)
function decidirDisponibilidade(marca, processos) {
  if (!Array.isArray(processos) || processos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro encontrado (busca exata)', processos: [] };
  }

  const alvo = normalize(marca);
  const exatos = processos.filter(p => normalize(p.marca || '') === alvo);

  if (exatos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro exato encontrado', processos: [] };
  }

  const todasPermitem = exatos.every(p => situacaoPermite(p.situacao));
  if (todasPermitem) {
    return {
      disponivel: true,
      motivo: 'Somente situações terminais que permitem novo registro',
      processos: exatos.map(p => ({ numero: p.numero, situacao: p.situacao, titular: p.titular, classe: p.classe }))
    };
  }

  return {
    disponivel: false,
    motivo: 'Há situação(ões) não-terminais (ex.: registro em vigor/alto renome/em exame/publicada/sobrestado)',
    processos: exatos.map(p => ({ numero: p.numero, situacao: p.situacao, titular: p.titular, classe: p.classe }))
  };
}

// ============================ INPI (Infosimples) ============================
async function consultarINPI(marca) {
  const token = process.env.INFOSIMPLES_TOKEN;
  if (!token) {
    const e = new Error('Token Infosimples não configurado');
    e.code = 'CONFIG';
    throw e;
  }

  const url = 'https://api.infosimples.com/api/v2/consultas/inpi/marcas';
  const requestBody = { token, marca, tipo: 'exata' }; // SEMPRE E SÓ EXATA

  const response = await axios.post(url, requestBody, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });

  return response.data; // formato com { data: [{ processos: [...] , ... }] }
}

// ============================ Handler ============================
export default async function handler(req, res) {
  const t0 = Date.now();

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido', mensagem: 'Use POST para consultar marcas' });
  }

  const { marca } = req.body || {};
  if (!marca || typeof marca !== 'string' || marca.trim() === '') {
    return res.status(422).json({ erro: 'Validação falhou', mensagem: 'O campo "marca" é obrigatório e não pode ser vazio' });
  }

  const marcaTrimmed = marca.trim();

  try {
    // 1) Consulta exata
    const resultado = await consultarINPI(marcaTrimmed);

    // 2) Extrai processos (pode vir paginado em "data" – Infosimples já consolida por página)
    const processos = extrairProcessos(resultado);

    // 3) Decide
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
        timestamp: new Date().toISOString(),
        tempo_resposta_ms: Date.now() - t0
      }
    });

  } catch (error) {
    // Upstream com status conhecido
    if (error?.response) {
      const status = error.response.status;
      // 4xx/5xx da Infosimples/INPI => trate como 502 (upstream)
      return res.status(502).json({
        erro: 'Erro ao consultar INPI',
        mensagem: 'Serviço de consulta temporariamente indisponível',
        detalhes: error.response.data?.message || error.message,
        upstream_status: status
      });
    }

    // Timeout/rede
    if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
      return res.status(504).json({ erro: 'Timeout', mensagem: 'A consulta ao INPI excedeu o tempo limite' });
    }

    // Config ou genérico
    return res.status(500).json({ erro: 'Erro interno', mensagem: error.message || 'Falha inesperada' });
  }
}
