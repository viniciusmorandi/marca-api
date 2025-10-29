// /api/busca-marca.js
// Consulta INPI com HTTP+Cheerio e fallback Playwright (opcional)
// - Retry exponencial
// - User-Agent rotativo
// - Micro-cache por marca
// - Saída validada com AJV
// - CORS liberado p/ Wix/n8n

import axios from 'axios';
import * as cheerio from 'cheerio';
import Ajv from 'ajv';

// =========================
// Feature flag do Playwright
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
  const min = 10 * 60 * 1000; // 10 min
  const max = 30 * 60 * 1000; // 30 min
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { CACHE.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  CACHE.set(key, { value, expiresAt: Date.now() + getTTLms() });
}

const stripDiacriticsLower = (s = '') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const canonical = (s = '') => stripDiacriticsLower(s).replace(/[^a-z0-9]+/g, '');

const equalsLoose = (a = '', b = '') => {
  const A = canonical(a);
  const B = canonical(b);
  return A === B || A.includes(B) || B.includes(A);
};

const TERMINAIS_STEMS = [
  'indeferid', 'negad', 'arquiv', 'extint', 'caducad', 'cancelad',
  'nulidade procedent', 'nulo', 'renunci'
];
const situacaoPermite = (situacao = '') =>
  TERMINAIS_STEMS.some(stem => stripDiacriticsLower(situacao).includes(stem));

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
    // Se quiser remover `processos` do JSON final, basta tirar este campo
    processos: { type: 'array', items: {
      type: 'object',
      additionalProperties: true
    }, nullable: true },
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

  // Algumas páginas do INPI podem renderizar múltiplas tabelas; escolhemos a que tem cabeçalhos esperados
  $('table').each((_, tbl) => {
    const headerText = $(tbl).text().toLowerCase();

    const looksLikeResults =
      headerText.includes('resultado da pesquisa') ||
      (headerText.includes('número') && headerText.includes('situação') && headerText.includes('classe'));

    if (!looksLikeResults) return;

    $(tbl).find('tr').each((i, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 5) return; // linhas de cabeçalho

      // O INPI varia a quantidade/ordem das colunas. Capturamos pelos índices mais comuns.
      const numero   = $(tds[0]).text().trim();                 // Número do processo
      const prioridade = $(tds[1]).text().trim();               // Prioridade (às vezes existe)
      const tipo     = $(tds[2]).text().trim();                 // Tipo (nominativa/mista, etc.)
      const marca    = $(tds[3]).text().trim();                 // Marca
      const registro = $(tds[4]).text().trim();                 // "Marca Registrada"/"Marca Arquivada"...
      const situacao = $(tds[5] || tds[4]).text().trim();       // Situação (Registro em vigor, Arquivado...)
      const titular  = $(tds[6] || tds[5]).text().trim();       // Titular
      const classe   = $(tds[7] || tds[6]).text().trim();       // Classe

      if (numero || marca || situacao) {
        linhas.push({ numero, prioridade, tipo, marca, registro, situacao, titular, classe });
      }
    });
  });

  return linhas;
}

// ==============================
// Scraper #1: HTTP + Cheerio
// ==============================
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
    const url = urlBuilder(termoMarca);
    const ua  = pickUA(attempt - 1);

    try {
      const { data: html, status } = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': ua,
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cache-Control': 'no-cache'
        },
        // INPI às vezes responde 302/200 com HTML estranho; vamos validar manualmente
        validateStatus: () => true
      });

      if (status >= 200 && status < 300 && typeof html === 'string') {
        return html;
      }

      // Re-tentáveis
      if ([429, 500, 502, 503, 504].includes(status)) {
        lastError = new Error(`HTTP ${status}`);
        await backoffWait(attempt);
        continue;
      }

      throw new Error(`Status não esperado: ${status}`);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) await backoffWait(attempt);
    }
  }

  throw lastError || new Error('Falha HTTP após tentativas');
}

async function tentarCheerio(marca) {
  for (const build of CANDIDATE_ENDPOINTS) {
    try {
      const html = await httpGetWithRetry(build, marca, 3);
      if (typeof html === 'string' && html.toLowerCase().includes('resultado da pesquisa')) {
        const processos = parseTabelaHTML(html);

        const $ = cheerio.load(html);
        let paginas = 1;
        const bodyTxt = $('body').text();
        const m = bodyTxt.match(/P[áa]ginas de Resultados:\s*([\s\S]*?)$/i);
        if (m) {
          const qtd = (m[1].match(/\d+/g) || []).map(Number);
          const max = Math.max(1, ...qtd);
          if (Number.isFinite(max)) paginas = max;
        }

        return {
          processos,
          paginasColetadas: 1,
          metodo: 'cheerio',
          paginasTotal: paginas,
          urlUsada: build(marca)
        };
      }
    } catch {
      // tenta próximo endpoint
    }
  }
  return null;
}

// ====================================
// Scraper #2: Playwright (opcional)
// ====================================
async function tentarPlaywright(marca) {
  if (!PLAYWRIGHT_ENABLED) throw new Error('PLAYWRIGHT_DISABLED');

  const { chromium } = await getPlaywright();
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--single-process'
    ]
  });

  try {
    const page = await browser.newPage({
      userAgent: pickUA(Math.floor(Math.random() * USER_AGENTS.length)),
      viewport: { width: 1366, height: 768 }
    });

    await page.goto(`${INPI_BASE}/jsp/marcas/Pesquisa_classe_basica.jsp`, {
      timeout: 30000,
      waitUntil: 'domcontentloaded'
    });

    // Preenche o campo de marca (há variações de name/id no INPI)
    const inputCandidates = [
      'input[name="Marca"]',
      'input[name="marca"]',
      'input[name="expressao"]',
      'input[type="text"]',
      'input'
    ];
    let filled = false;
    for (const sel of inputCandidates) {
      const el = page.locator(sel).first();
      if (await el.count()) {
        try {
          await el.fill('');
          await el.type(marca, { delay: 5 });
          filled = true;
          break;
        } catch {}
      }
    }
    if (!filled) {
      try {
        const lbl = page.getByLabel(/marca/i).first();
        await lbl.fill('');
        await lbl.type(marca, { delay: 5 });
        filled = true;
      } catch {}
    }
    if (!filled) throw new Error('Não foi possível localizar o campo de marca no INPI.');

    // Submete
    const btnCandidates = [
      'input[type="submit"]',
      'button[type="submit"]',
      'input[value*="Pesquisar"]',
      'button:has-text("Pesquisar")',
      'input[value*="Buscar"]',
      'button:has-text("Buscar")'
    ];
    let submitted = false;
    for (const sel of btnCandidates) {
      const b = page.locator(sel).first();
      if (await b.count()) {
        try {
          await Promise.all([page.waitForLoadState('domcontentloaded'), b.click()]);
          submitted = true;
          break;
        } catch {}
      }
    }
    if (!submitted) {
      await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded');
    }

    const html = await page.content();
    const processos = parseTabelaHTML(html);

    const $ = cheerio.load(html);
    let paginas = 1;
    const txt = $('body').text();
    const m = txt.match(/P[áa]ginas de Resultados:\s*([\s\S]*?)$/i);
    if (m) {
      const qtd = (m[1].match(/\d+/g) || []).map(Number);
      const max = Math.max(1, ...qtd);
      if (Number.isFinite(max)) paginas = max;
    }

    return { processos, paginasColetadas: 1, metodo: 'playwright', paginasTotal: paginas };
  } finally {
    await browser.close().catch(() => {});
  }
}

// =====================
// Decisão de disponibilidade
// =====================
function decidirDisponibilidade(marcaDigitada, processos) {
  if (!Array.isArray(processos) || processos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro encontrado (busca exata)' };
  }

  const exatos = processos.filter(p => equalsLoose(p.marca || '', marcaDigitada));
  if (exatos.length === 0) return { disponivel: true, motivo: 'Nenhum registro exato encontrado' };

  const todasTerminais = exatos.every(p => situacaoPermite(p.situacao || ''));
  if (todasTerminais) return { disponivel: true, motivo: 'Todas as situações são terminais (permite registro)' };

  return {
    disponivel: false,
    motivo: 'Há situação(ões) não-terminais (ex.: registro em vigor, Alto Renome, exame, publicação, etc.)'
  };
}

// ==============
// Handler (API)
// ==============
export default async function handler(req, res) {
  const t0 = Date.now();

  // CORS p/ Wix/n8n
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ erro: 'Método não permitido', mensagem: 'Use POST (ou GET com ?marca=...)' });
  }

  const marca = (req.method === 'POST' ? req.body?.marca : req.query?.marca) ?? '';
  if (!marca || typeof marca !== 'string' || marca.trim() === '') {
    return res.status(422).json({
      erro: 'Validação falhou',
      mensagem: 'O campo "marca" é obrigatório e deve ser uma string não vazia'
    });
  }
  const marcaTrimmed = marca.trim();

  // Micro-cache
  const cacheKey = `marca:${canonical(marcaTrimmed)}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.status(200).json({
      ...cached,
      metadata: { ...cached.metadata, tempo_resposta_ms: Date.now() - t0 }
    });
  }

  try {
    // 1) Tenta Cheerio
    let resultado = await tentarCheerio(marcaTrimmed);

    // 2) Fallback: Playwright (se habilitado)
    if (!resultado || !Array.isArray(resultado.processos)) {
      try {
        resultado = await tentarPlaywright(marcaTrimmed);
      } catch (e) {
        if (e.message === 'PLAYWRIGHT_DISABLED') {
          // Nunca retorna 500 só porque faltou o navegador
          const resposta = {
            marca: marcaTrimmed,
            disponivel: false,
            motivo: 'Fallback com navegador desativado no servidor.',
            processos: [],
            metadata: {
              fonte: 'INPI (site oficial)',
              tipo_busca: 'exata',
              metodo: 'desativado',
              timestamp: new Date().toISOString(),
              tempo_resposta_ms: Date.now() - t0,
              paginas_coletadas: 0
            }
          };
          // Se quiser **não** retornar `processos` ao front, remova a chave acima.
          if (!validateResponse(resposta)) {
            console.error('Ajv errors (flag off):', validateResponse.errors);
          }
          cacheSet(cacheKey, resposta);
          return res.status(200).json(resposta);
        }
        // Outro erro do Playwright
        console.error('ERRO scraper INPI', { msg: e.message, stack: e.stack });
        return res.status(502).json({ erro: 'INPI indisponível', mensagem: 'Falha ao renderizar página do INPI (Playwright)' });
      }
    }

    if (!resultado || !Array.isArray(resultado.processos)) {
      return res.status(502).json({ erro: 'Falha ao consultar INPI', mensagem: 'Não foi possível extrair resultados da pesquisa' });
    }

    const { processos, paginasColetadas, metodo } = resultado;
    const decisao = decidirDisponibilidade(marcaTrimmed, processos);

    const resposta = {
      marca: marcaTrimmed,
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
      processos, // <- remova esta linha se não quiser enviar a lista crua
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
