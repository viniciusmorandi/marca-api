import axios from 'axios';
import * as cheerio from 'cheerio';
import Ajv from 'ajv';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import iconv from 'iconv-lite';

// =========================
// Feature flag Playwright
// =========================
const PLAYWRIGHT_ENABLED = process.env.PLAYWRIGHT_ENABLED === 'true';

let _playwright = null;
async function getPlaywright() {
  if (_playwright) return _playwright;
  const { chromium } = await import('playwright-core');
  _playwright = { chromium };
  return _playwright;
}

// ============
// Utilitários
// ============
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CACHE = new Map();
function getTTLms() { return 15 * 60 * 1000; } // 15min
function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { CACHE.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  CACHE.set(key, { value, expiresAt: Date.now() + getTTLms() });
}

function stripDiacriticsLower(s = '') { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function canonical(s = '') { return stripDiacriticsLower(s).replace(/[^a-z0-9]+/g, ''); }
const TERMINAIS_STEMS = ['indeferid', 'negad', 'arquiv', 'extint', 'caducad', 'cancelad', 'nulidade procedent', 'nulo', 'renunci'];
function situacaoPermite(situacao = '') { return TERMINAIS_STEMS.some(stem => stripDiacriticsLower(situacao).includes(stem)); }
function equalsLoose(a = '', b = '') {
  const A = canonical(a);
  const B = canonical(b);
  return A === B || A.includes(B) || B.includes(A);
}

// ==============
// Schema de saída
// ==============
const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['marca','disponivel','motivo','metadata'],
  additionalProperties: false,
  properties: {
    marca: { type: 'string' },
    disponivel: { type: 'boolean' },
    motivo: { type: 'string' },
    processos: { type: 'array', items: { type: 'object', additionalProperties: true }, nullable: true },
    metadata: {
      type: 'object',
      required: ['fonte','tipo_busca','timestamp','tempo_resposta_ms','paginas_coletadas','metodo'],
      additionalProperties: false,
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

// ================================
// Parser de tabela HTML do INPI
// ================================
function parseTabelaHTML(html) {
  const $ = cheerio.load(html);
  const linhas = [];
  $('table').each((_, tbl) => {
    const headerText = $(tbl).text().toLowerCase();
    const looksLikeResults =
      headerText.includes('resultado da pesquisa') ||
      (headerText.includes('número') && headerText.includes('situação') && headerText.includes('classe'));
    if (!looksLikeResults) return;
    $(tbl).find('tr').each((i, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 5) return;
      const numero   = $(tds[0]).text().trim();
      const prioridade = $(tds[1]).text().trim();
      const tipo     = $(tds[2]).text().trim();
      const marca    = $(tds[3]).text().trim();
      const registro = $(tds[4]).text().trim();
      const situacao = $(tds[5] || tds[4]).text().trim();
      const titular  = $(tds[6] || tds[5]).text().trim();
      const classe   = $(tds[7] || tds[6]).text().trim();
      if (numero || marca || situacao) {
        linhas.push({ numero, prioridade, tipo, marca, registro, situacao, titular, classe });
      }
    });
  });
  return linhas;
}

// ==============================
// Scraper: HTTP + Cheerio com sessão/cookie
// ==============================
const INPI_BASE = 'https://busca.inpi.gov.br/pePI';

function makeClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache'
    },
    validateStatus: () => true,
  }));
  return client;
}
function decodeBody(buffer, contentType = '') {
  const ct = (contentType || '').toLowerCase();
  const isLatin1 = ct.includes('iso-8859-1') || ct.includes('latin1');
  return isLatin1 ? iconv.decode(buffer, 'latin1') : iconv.decode(buffer, 'utf8');
}
async function httpGetHtml(client, url, referer) {
  const res = await client.get(url, {
    headers: referer ? { Referer: referer } : undefined,
  });
  const html = decodeBody(res.data, res.headers['content-type'] || '');
  return { status: res.status, html, headers: res.headers };
}
async function tentarCheerio(marca) {
  try {
    const client = makeClient();
    // Preflight: abre sessão e recebe cookie JSESSIONID
    const preflightUrl = `${INPI_BASE}/jsp/marcas/Pesquisa_classe_basica.jsp`;
    await httpGetHtml(client, preflightUrl);

    const endpoints = [
      (m) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&Marca=${encodeURIComponent(m)}`,
      (m) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&marca=${encodeURIComponent(m)}`,
      (m) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&expressao=${encodeURIComponent(m)}`
    ];

    for (const build of endpoints) {
      const url = build(marca);
      const { status, html } = await httpGetHtml(client, url, preflightUrl);
      // Log básico para debug de erro/resultado:
      console.warn('INPI html sample', { status, snippet: html.slice(0, 200) });
      if (status >= 200 && status < 400 && typeof html === 'string') {
        const $ = cheerio.load(html);
        const pageText = $('body').text().toLowerCase();
        const looksLikeResult = pageText.includes('resultado da pesquisa') || $('table').length > 0;
        if (looksLikeResult) {
          const processos = parseTabelaHTML(html);
          return {
            processos,
            paginasColetadas: 1,
            metodo: 'cheerio',
            paginasTotal: 1,
            urlUsada: url
          };
        }
      }
      // Pequeno backoff se erro HTTP
      if ([429, 500, 502, 503, 504].includes(status)) {
        await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
        continue;
      }
    }
    return null; // Força fallback (Playwright)
  } catch (err) {
    console.error('Falha técnica Cheerio:', err);
    return null;
  }
}

// ====================================
// Decisão de disponibilidade
// ====================================
function decidirDisponibilidade(marcaDigitada, processos) {
  if (!Array.isArray(processos) || processos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro encontrado (busca exata)' };
  }
  const exatos = processos.filter(p => equalsLoose(p.marca || '', marcaDigitada));
  if (exatos.length === 0) return { disponivel: true, motivo: 'Nenhum registro exato encontrado' };
  const todasTerminais = exatos.every(p => situacaoPermite(p.situacao || ''));
  if (todasTerminais) return { disponivel: true, motivo: 'Todas as situações são terminais (permite registro)' };
  return { disponivel: false, motivo: 'Há situação(ões) não-terminais (ex.: registro em vigor, Alto Renome, exame, publicação, etc.)' };
}

// ==============
// Handler (API) - CORS liberado para Wix/n8n
// ==============
export default async function handler(req, res) {
  const t0 = Date.now();
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
  const cacheKey = `marca:${canonical(marcaTrimmed)}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.status(200).json({ ...cached, metadata: { ...cached.metadata, tempo_resposta_ms: Date.now() - t0 } });
  }

  try {
    // 1) Tenta Cheerio (robusto/sessão/latin1)
    let resultado = await tentarCheerio(marcaTrimmed);

    // 2) Fallback Playwright (opcional - seu código, se quiser ativar para casos bloqueados)
    // if (!resultado || !Array.isArray(resultado.processos)) {
    //   try {
    //     resultado = await tentarPlaywright(marcaTrimmed);
    //   } catch {
    //     // Fallback seguro caso Playwright não disponível
    //     resultado = { processos: [], paginasColetadas: 0, metodo: 'desativado', paginasTotal: 0 };
    //   }
    // }

    if (!resultado || !Array.isArray(resultado.processos)) {
      return res.status(502).json({ erro: 'Falha ao consultar INPI', mensagem: 'Não foi possível extrair resultados da pesquisa' });
    }

    const { processos, paginasColetadas, metodo } = resultado;
    const decisao = decidirDisponibilidade(marcaTrimmed, processos);

    const resposta = {
      marca: marcaTrimmed,
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
      processos,
      metadata: {
        fonte: 'INPI (site oficial)',
        tipo_busca: 'exata',
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
    console.error('ERRO scraper INPI', { msg: err.message, stack: err.stack });
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ erro: 'Timeout na consulta ao INPI' });
    }
    return res.status(500).json({ erro: 'Erro interno', mensagem: 'Falha inesperada ao consultar INPI' });
  }
}
