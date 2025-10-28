import axios from 'axios';
import Ajv from 'ajv';

/* ============================================================================
 * Normalização e comparação tolerante
 * ========================================================================== */
const stripDiacriticsLower = (s = '') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const canonical = (s = '') => stripDiacriticsLower(s).replace(/[^a-z0-9]+/g, '');
const equalsLoose = (a = '', b = '') => {
  const A = canonical(a), B = canonical(b);
  return A === B || A.includes(B) || B.includes(A);
};

/* ============================================================================
 * Situações TERMINAIS (qualquer outra => INDISPONÍVEL)
 * ========================================================================== */
const TERMINAIS_STEMS = [
  'indeferid', 'negad', 'arquiv', 'extint', 'caducad',
  'cancelad', 'nulidade procedent', 'nulo', 'renunci'
];
const situacaoPermite = (situacao = '') =>
  TERMINAIS_STEMS.some(stem => stripDiacriticsLower(situacao).includes(stem));
const getSituacao = (proc = {}) =>
  proc.situacao || proc.situacao_processual || proc.status || proc.registro || '';

/* ============================================================================
 * Validação (Ajv)
 * ========================================================================== */
const ajv = new Ajv({ allErrors: true });
const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['marca', 'disponivel', 'motivo', 'processos', 'metadata'],
  properties: {
    marca: { type: 'string' },
    disponivel: { type: 'boolean' },
    motivo: { type: 'string' },
    processos: { type: 'array' },
    metadata: { type: 'object' }
  }
};
const validateResponse = ajv.compile(RESPONSE_SCHEMA);

/* ============================================================================
 * Parsing e Infosimples
 * ========================================================================== */
const extrairProcessos = (r) =>
  Array.isArray(r?.data) ? r.data.flatMap(b => b.processos || []) : [];
const extrairTotalPaginas = (r) =>
  (r?.data?.[0]?.total_paginas) || r?.total_paginas || 1;

async function consultarINPI_TodasPaginas(marca) {
  const token = process.env.INFOSIMPLES_TOKEN;
  if (!token) throw new Error('Token Infosimples não configurado');

  const url = 'https://api.infosimples.com/api/v2/consultas/inpi/marcas';
  const headers = { 'Content-Type': 'application/json' };

  const coletar = async (pagina = 1) => {
    const { data } = await axios.post(
      url, { token, marca, tipo: 'exata', pagina },
      { headers, timeout: 20000 }
    );
    return data;
  };

  const first = await coletar(1);
  if ([612, 615].includes(first?.code)) {
    const e = new Error('INPI fora do ar');
    e.code = 'INPI_DOWN';
    throw e;
  }
  if (first?.code !== 200) {
    const e = new Error(first?.code_message || 'Erro Infosimples');
    e.code = 'UPSTREAM';
    throw e;
  }

  let blocos = Array.isArray(first.data) ? [...first.data] : [];
  for (let p = 2; p <= extrairTotalPaginas(first); p++) {
    const next = await coletar(p);
    if (next?.code === 200 && Array.isArray(next.data)) blocos.push(...next.data);
  }
  return { code: 200, data: blocos };
}

/* ============================================================================
 * Decisão de disponibilidade
 * ========================================================================== */
function decidirDisponibilidade(marcaDigitada, processos) {
  if (!Array.isArray(processos) || processos.length === 0)
    return { disponivel: true, motivo: 'Nenhum registro encontrado (busca exata)', processos: [] };

  const alvo = canonical(marcaDigitada);
  const relevantes = processos.filter(p => {
    const nome = p?.marca || '';
    return equalsLoose(nome, marcaDigitada) || canonical(nome).includes(alvo);
  });

  if (relevantes.length === 0)
    return { disponivel: true, motivo: 'Nenhum registro exato encontrado', processos: [] };

  const algumAtivo = relevantes.some(p => !situacaoPermite(getSituacao(p)));
  if (algumAtivo)
    return { disponivel: false, motivo: 'Há registros em vigor ou em andamento.', processos: [] };

  return { disponivel: true, motivo: 'Todas as situações são terminais (permite registro)', processos: [] };
}

/* ============================================================================
 * Handler principal (Vercel)
 * ========================================================================== */
export default async function handler(req, res) {
  const t0 = Date.now();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const marca = (req.method === 'POST' ? req.body?.marca : req.query?.marca) ?? '';
  if (!marca || typeof marca !== 'string' || marca.trim() === '')
    return res.status(422).json({ erro: 'Campo \"marca\" obrigatório' });

  try {
    const bruto = await consultarINPI_TodasPaginas(marca.trim());
    const processos = extrairProcessos(bruto);
    const decisao = decidirDisponibilidade(marca.trim(), processos);

    const body = {
      marca: marca.trim(),
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
      processos: [],
      metadata: {
        fonte: 'INPI via Infosimples',
        tipo_busca: 'exata',
        timestamp: new Date().toISOString(),
        tempo_resposta_ms: Date.now() - t0,
        paginas_coletadas: extrairTotalPaginas(bruto)
      }
    };

    if (!validateResponse(body))
      return res.status(500).json({ erro: 'Formato inválido' });

    return res.status(200).json(body);
  } catch (err) {
    console.error('ERRO', err.message);
    if (err.code === 'INPI_DOWN')
      return res.status(503).json({ disponivel: false, motivo: '⚠️ INPI fora do ar. Tente novamente em alguns minutos.' });
    if (err.code === 'UPSTREAM')
      return res.status(502).json({ disponivel: false, motivo: 'Erro na comunicação com o INPI.' });
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')
      return res.status(504).json({ disponivel: false, motivo: '⏱️ Tempo de resposta excedido.' });
    return res.status(500).json({ disponivel: false, motivo: '❌ Erro interno ao processar a consulta.' });
  }
}
