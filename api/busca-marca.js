// /api/busca-marca.js
// WIPO (IPO-BR) primeiro, INPI (Cheerio) como fallback. Sem Playwright.

import axios from 'axios';
import * as cheerio from 'cheerio';
import Ajv from 'ajv';

// ========== Utils: UA, backoff, cache ==========
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
];
const pickUA = (i = 0) => USER_AGENTS[i % USER_AGENTS.length];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function backoffWait(attempt, baseMs = 350) {
  const exp = Math.min(6, attempt);
  const delay = baseMs * Math.pow(2, exp - 1);
  const jitter = Math.floor(Math.random() * (delay * 0.25));
  await sleep(delay + jitter);
}

const CACHE = new Map();
function getTTLms() {
  const min = 10 * 60 * 1000, max = 30 * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { CACHE.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) { CACHE.set(key, { value, expiresAt: Date.now() + getTTLms() }); }

// ========== Normalização/decisão ==========
const stripDiacriticsLower = (s = '') => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const canonical = (s = '') => stripDiacriticsLower(s).replace(/[^a-z0-9]+/g, '');
const equalsLoose = (a = '', b = '') => {
  const A = canonical(a); const B = canonical(b);
  return A === B || A.includes(B) || B.includes(A);
};

// Situações que permitem novo registro (terminais/inativas)
const TERMINAIS_STEMS = [
  // PT
  'indeferid','negad','arquiv','extint','caducad','cancelad','nulidade procedent','nulo','renunci',
  // EN (WIPO)
  'expired','cancelled','canceled','withdrawn','abandoned','dead'
];
const situacaoPermite = (situacao = '') => {
  const s = stripDiacriticsLower(situacao);
  return TERMINAIS_STEMS.some(stem => s.includes(stem));
};

// ========== Schema de resposta (AJV) ==========
const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['marca','disponivel','motivo','metadata'],
  additionalProperties: true,
  properties: {
    marca: { type: 'string' },
    disponivel: { type: 'boolean' },
    motivo: { type: 'string' },
    processos: { type: 'array' },
    metadata: {
      type: 'object',
      required: ['fonte','tipo_busca','timestamp','tempo_resposta_ms','paginas_coletadas','metodo'],
      additionalProperties: true,
      properties: {
        fonte: { type: 'string' },
        tipo_busca: { type: 'string' },
        timestamp: { type: 'string' },
        tempo_resposta_ms: { type: 'number' },
        paginas_coletadas: { type: 'number' },
        metodo: { type: 'string' }
      }
    }
  }
};
const ajv = new Ajv({ allErrors: true });
const validateResponse = ajv.compile(RESPONSE_SCHEMA);

// ========== WIPO (IPO-BR) primeiro ==========
const WIPO_BASE = 'https://branddb.wipo.int/pt/IPO-BR/similarname';

function buildWipoAsStructure(marca) {
  // Estrutura mínima para "brand name contém <marca>"
  return {
    boolean: 'AND',
    bricks: [
      {
        field: 'BRAND_NAME',
        operator: 'CONTAINS',
        value: marca
      }
    ]
  };
}

async function httpGetWipo(url, cookieJar = '') {
  const headers = {
    'User-Agent': pickUA(Math.floor(Math.random() * USER_AGENTS.length)),
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    ...(cookieJar ? { 'Cookie': cookieJar } : {})
  };
  const resp = await axios.get(url, { timeout: 15000, headers, validateStatus: () => true });
  return resp;
}

function parseWipoResultsHTML(html) {
  const $ = cheerio.load(html);
  const rows = [];

  // Contêiner de resultados (pode variar por release). Usamos seletores amplos.
  $('[data-test="results-container"] .result, .results table tr, .results .result-row').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    const marcaMatch = text.match(/^\s*([^\n]+?)(?:\s+(Owner|Titular|Propriet[aá]rio|Nice class|Classe|Status)\b)/i);
    const situacaoMatch = text.match(/\b(Status|Situa[çc][aã]o)\s*[:\-]?\s*([A-Za-z0-9 /,.\-()]+?)(?:\s|$)/i);
    const titularMatch = text.match(/\b(Owner|Titular|Propriet[aá]rio)\s*[:\-]?\s*([A-Za-z0-9\.,&\-\/() ]+)/i);
    const classeMatch = text.match(/\b(Nice class|Classe)\s*[:\-]?\s*([\d, ]+)/i);

    const marca = marcaMatch ? marcaMatch[1].trim() : '';
    const situacao = situacaoMatch ? situacaoMatch[2].trim() : '';
    const titular = titularMatch ? titularMatch[2].trim() : '';
    const classe = classeMatch ? classeMatch[2].trim() : '';

    if (marca || situacao || titular || classe) {
      rows.push({ marca, situacao, titular, classe });
    }
  });

  return rows;
}

async function tentarWipo(marca) {
  // 1) Preflight para cookie/sessão
  const pre = await httpGetWipo(`${WIPO_BASE}`);
  const cookieJar = (pre.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  // 2) Resultados
  const asStructure = buildWipoAsStructure(marca);
  const qs = new URLSearchParams({
    sort: 'score desc',
    start: '0',
    rows: '30',
    asStructure: JSON.stringify(asStructure)
  });
  const url = `${WIPO_BASE}/results?${qs.toString()}`;

  const { status, data: html } = await httpGetWipo(url, cookieJar);
  if (!(status >= 200 && status < 300) || typeof html !== 'string') {
    throw new Error(`WIPO HTTP ${status}`);
  }

  const processos = parseWipoResultsHTML(html);
  return {
    processos,
    paginasColetadas: 1,
    metodo: 'wipo',
    urlUsada: url,
    rawHtml: html
  };
}

// ========== INPI (Cheerio) como fallback ==========
const INPI_BASE = 'https://busca.inpi.gov.br/pePI';
const CANDIDATE_ENDPOINTS = [
  (marca) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&Marca=${encodeURIComponent(marca)}`,
  (marca) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&marca=${encodeURIComponent(marca)}`,
  (marca) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&expressao=${encodeURIComponent(marca)}`,
  (marca) => `${INPI_BASE}/jsp/marcas/Pesquisa_classe_basica.jsp?Marca=${encodeURIComponent(marca)}`
];

async function httpGetWithRetry(urlBuilder, termoMarca, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = urlBuilder(termoMarca); const ua = pickUA(attempt - 1);
    try {
      const { data: html, status } = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': ua,
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache'
        },
        validateStatus: () => true
      });
      if (status >= 200 && status < 300 && typeof html === 'string') return html;
      if ([429, 500, 502, 503, 504].includes(status)) { lastError = new Error(`HTTP ${status}`); await backoffWait(attempt); continue; }
      throw new Error(`Status não esperado: ${status}`);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) await backoffWait(attempt);
    }
  }
  throw lastError || new Error('Falha HTTP após tentativas');
}

function parseTabelaINPI(html) {
  const $ = cheerio.load(html);
  const linhas = [];
  const tabelas = $('table');

  tabelas.each((_, tbl) => {
    const headTxt = $(tbl).text().toLowerCase();
    if (headTxt.includes('número') && headTxt.includes('marca') && headTxt.includes('situação') && headTxt.includes('classe')) {
      $(tbl).find('tr').each((i, tr) => {
        const tds = $(tr).find('td');
        if (tds.length >= 7) {
          const numero = $(tds[0]).text().trim();
          const marca = $(tds[3]).text().trim();
          const situacao = $(tds[5]).text().trim();
          const titular = $(tds[6]).text().trim();
          const classe = $(tds[7] || tds[6]).text().trim();
          if (numero || marca || situacao) linhas.push({ numero, marca, situacao, titular, classe });
        }
      });
    }
  });

  return linhas;
}

async function tentarINPI(marca) {
  for (const build of CANDIDATE_ENDPOINTS) {
    try {
      const html = await httpGetWithRetry(build, marca, 3);
      if (typeof html === 'string' && html.toLowerCase().includes('resultado da pesquisa')) {
        const processos = parseTabelaINPI(html);
        // leitura de número de páginas (best-effort)
        const $ = cheerio.load(html);
        let paginas = 1;
        const rodape = $('body').text();
        const m = rodape.match(/P[áa]ginas de Resultados:\s*([\s\S]*?)$/i);
        if (m) {
          const qtd = (m[1].match(/\d+/g) || []).map(Number);
          const max = Math.max(1, ...qtd);
          if (Number.isFinite(max)) paginas = max;
        }
        return { processos, paginasColetadas: 1, metodo: 'inpi', urlUsada: build(marca), paginasTotal: paginas, rawHtml: html };
      }
    } catch { /* tenta o próximo endpoint */ }
  }
  return null;
}

// ========== Decisão de disponibilidade ==========
function decidirDisponibilidade(marcaDigitada, processos) {
  if (!Array.isArray(processos) || processos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro encontrado (busca aproximada)' };
  }
  const exatos = processos.filter(p => equalsLoose(p.marca || '', marcaDigitada));
  if (exatos.length === 0) return { disponivel: true, motivo: 'Nenhum registro exato encontrado' };
  const todasTerminais = exatos.every(p => situacaoPermite(p.situacao || ''));
  if (todasTerminais) return { disponivel: true, motivo: 'Todas as situações são terminais (permite registro)' };
  return { disponivel: false, motivo: 'Há situação(ões) não-terminais (ex.: registro em vigor, exame/publicação, etc.)' };
}

// ========== Handler ==========
export default async function handler(req, res) {
  const t0 = Date.now();

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ erro: 'Método não permitido', mensagem: 'Use POST (ou GET com ?marca=...)' });
  }

  const marca = (req.method === 'POST' ? req.body?.marca : req.query?.marca) ?? '';
  if (!marca || typeof marca !== 'string' || marca.trim() === '') {
    return res.status(422).json({ erro: 'Validação falhou', mensagem: 'O campo "marca" é obrigatório e deve ser uma string não vazia' });
  }
  const marcaTrimmed = marca.trim();

  // Micro-cache
  const cacheKey = `marca:${canonical(marcaTrimmed)}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.status(200).json({ ...cached, metadata: { ...cached.metadata, tempo_resposta_ms: Date.now() - t0 } });
  }

  try {
    // 1) WIPO (IPO-BR) primeiro
    let resultado = null;
    try {
      resultado = await tentarWipo(marcaTrimmed);
    } catch (e) {
      // mantém null para fallback
    }

    // 2) Fallback: INPI (Cheerio) — opcional
    if (!resultado || !Array.isArray(resultado.processos) || resultado.processos.length === 0) {
      try {
        resultado = await tentarINPI(marcaTrimmed);
      } catch (e) {
        // segue para checagem final
      }
    }

    if (!resultado || !Array.isArray(resultado.processos)) {
      console.error('DEBUG WIPO/INPI FAIL', {
        htmlSnippet: (resultado && resultado.rawHtml ? String(resultado.rawHtml).slice(0, 800) : '')
      });
      return res.status(502).json({ erro: 'Falha ao consultar base de marcas', mensagem: 'Não foi possível extrair resultados' });
    }

    const { processos, paginasColetadas, metodo } = resultado;
    const decisao = decidirDisponibilidade(marcaTrimmed, processos);

    const resposta = {
      marca: marcaTrimmed,
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
      processos: processos.slice(0, 30), // saneamento
      metadata: {
        fonte: metodo === 'wipo' ? 'WIPO (Global Brand Database, IPO-BR)' : 'INPI (site oficial)',
        tipo_busca: metodo === 'wipo' ? 'similar-name' : 'exata',
        metodo,
        timestamp: new Date().toISOString(),
        tempo_resposta_ms: Date.now() - t0,
        paginas_coletadas: paginasColetadas ?? 1
      }
    };

    if (!validateResponse(resposta)) {
      console.error('Ajv errors:', validateResponse.errors);
      return res.status(500).json({ erro: 'Formato de resposta inválido' });
    }

    cacheSet(cacheKey, resposta);
    return res.status(200).json(resposta);

  } catch (err) {
    console.error('ERRO scraper', { msg: err.message, stack: err.stack });
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ erro: 'Timeout na consulta' });
    }
    return res.status(500).json({ erro: 'Erro interno', mensagem: 'Falha inesperada ao consultar bases de marcas' });
  }
}
