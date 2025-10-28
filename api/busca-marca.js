// /api/busca-marca.js
import axios from 'axios';
import * as cheerio from 'cheerio';
import Ajv from 'ajv';

// Opcional: carregamento dinâmico só quando o fallback for necessário
let _playwright = null;
async function getPlaywright() {
  if (_playwright) return _playwright;
  const { chromium } = await import('playwright-core');
  _playwright = { chromium };
  return _playwright;
}

/* ============================================================================
 * Normalização e comparação tolerante (acentos/caso/espaços/pontuação)
 * ========================================================================== */
const stripDiacriticsLower = (s = '') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const canonical = (s = '') => stripDiacriticsLower(s).replace(/[^a-z0-9]+/g, '');

const equalsLoose = (a = '', b = '') => {
  const A = canonical(a);
  const B = canonical(b);
  return A === B || A.includes(B) || B.includes(A);
};

/* ============================================================================
 * Situações TERMINAIS (qualquer outra => INDISPONÍVEL)
 * ========================================================================== */
const TERMINAIS_STEMS = [
  'indeferid',
  'negad',
  'arquiv',               // inclui "pedido definitivamente arquivado"
  'extint',               // "registro de marca extinto" etc.
  'caducad',
  'cancelad',
  'nulidade procedent',
  'nulo',
  'renunci'               // renúncia total
];

const situacaoPermite = (situacao = '') => {
  const s = stripDiacriticsLower(situacao);
  return TERMINAIS_STEMS.some(stem => s.includes(stem));
};

/* ============================================================================
 * Schema de resposta (sem resumo de processos, por pedido)
 * ========================================================================== */
const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['marca', 'disponivel', 'motivo', 'metadata'],
  additionalProperties: false,
  properties: {
    marca: { type: 'string' },
    disponivel: { type: 'boolean' },
    motivo: { type: 'string' },
    metadata: {
      type: 'object',
      required: ['fonte', 'tipo_busca', 'timestamp', 'tempo_resposta_ms', 'paginas_coletadas', 'metodo'],
      additionalProperties: false,
      properties: {
        fonte: { type: 'string' },
        tipo_busca: { type: 'string' },
        timestamp: { type: 'string' },
        tempo_resposta_ms: { type: 'number' },
        paginas_coletadas: { type: 'number' },
        metodo: { type: 'string' } // 'cheerio' | 'playwright'
      }
    }
  }
};
const ajv = new Ajv({ allErrors: true });
const validateResponse = ajv.compile(RESPONSE_SCHEMA);

/* ============================================================================
 * PARSER HTML (tabela oficial do INPI)
 * Lê linhas com colunas: Número | Prioridade | Tipo | Marca | [icone] | Situação | Titular | Classe
 * ========================================================================== */
function parseTabelaHTML(html) {
  const $ = cheerio.load(html);
  const linhas = [];

  // A página do INPI tem várias tabelas; a de resultados costuma ser a maior com cabeçalhos mencionados
  const tabelas = $('table');
  tabelas.each((_, tbl) => {
    const headTxt = $(tbl).text().toLowerCase();
    if (
      headTxt.includes('número') &&
      headTxt.includes('marca') &&
      headTxt.includes('situação') &&
      headTxt.includes('classe')
    ) {
      // Coletar linhas (ignorando cabeçalho)
      $(tbl)
        .find('tr')
        .each((i, tr) => {
          const tds = $(tr).find('td');
          if (tds.length >= 7) {
            const numero = $(tds[0]).text().trim();
            // tds[1] = prioridade
            // tds[2] = tipo
            const marca = $(tds[3]).text().trim();
            const situacao = $(tds[5]).text().trim(); // a coluna 4 geralmente é ícone "Marca Registrada"
            const titular = $(tds[6]).text().trim();
            const classe = $(tds[7] || tds[6]).text().trim(); // às vezes desloca 1 col

            if (numero || marca || situacao) {
              linhas.push({ numero, marca, situacao, titular, classe });
            }
          }
        });
    }
  });

  return linhas;
}

/* ============================================================================
 * SCRAPER #1 (rápido): Tenta rotas públicas (GET) do servlet diretamente
 * sem precisar de sessão. Testa alguns nomes de parâmetro conhecidos.
 * ========================================================================== */
const INPI_BASE = 'https://busca.inpi.gov.br/pePI';
const CANDIDATE_ENDPOINTS = [
  // padrão observado para consulta por número (exemplo conhecido):
  // /servlet/MarcasServletController?Action=searchMarca&NumPedido=XXXX&tipoPesquisa=BY_NUM_PROC
  // Para marca: BY_MARCA_CLASSIF_BASICA + possível param do termo:
  (marca) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&Marca=${encodeURIComponent(marca)}`,
  (marca) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&marca=${encodeURIComponent(marca)}`,
  (marca) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&expressao=${encodeURIComponent(marca)}`,
  // fallback genérico da JSP de pesquisa básica (algumas instalações aceitam GET com 'Marca')
  (marca) => `${INPI_BASE}/jsp/marcas/Pesquisa_classe_basica.jsp?Marca=${encodeURIComponent(marca)}`
];

async function tentarCheerio(marca) {
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  for (const build of CANDIDATE_ENDPOINTS) {
    const url = build(marca);
    try {
      const { data: html, status } = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
      });
      if (status >= 200 && status < 300 && typeof html === 'string') {
        // Ver se é uma página de resultado mesmo
        if (html.toLowerCase().includes('resultado da pesquisa')) {
          const processos = parseTabelaHTML(html);
          // Tentar descobrir no rodapé "Páginas de Resultados: 1 | 2 | ..." (se existir)
          const $ = cheerio.load(html);
          let paginas = 1;
          const rodape = $('body').text();
          const m = rodape.match(/P[áa]ginas de Resultados:\s*([\s\S]*?)$/i);
          if (m) {
            const qtd = (m[1].match(/\d+/g) || []).map(Number);
            const max = Math.max(1, ...qtd);
            if (Number.isFinite(max)) paginas = max;
          }
          return { processos, paginasColetadas: 1, metodo: 'cheerio', urlUsada: url, paginasTotal: paginas };
        }
      }
    } catch {
      // Tenta próxima variação
    }
  }
  // sem sucesso
  return null;
}

/* ============================================================================
 * SCRAPER #2 (robusto): Playwright abre a página e simula a busca
 * - Acessa a página de busca básica
 * - Preenche o campo da marca (tenta vários seletores)
 * - Submete o formulário
 * - Captura HTML e parseia com cheerio
 * ========================================================================== */
async function tentarPlaywright(marca) {
  const { chromium } = await getPlaywright();
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  });

  try {
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 }
    });

    // 1) Ir para a pesquisa básica
    await page.goto(`${INPI_BASE}/jsp/marcas/Pesquisa_classe_basica.jsp`, { timeout: 30000, waitUntil: 'domcontentloaded' });

    // 2) Encontrar o input da marca — tentamos por label e por nomes comuns
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
        } catch {
          // tenta próximo seletor
        }
      }
    }

    if (!filled) {
      // Tenta pela label visível "Marca"
      try {
        const lbl = page.getByLabel(/marca/i).first();
        await lbl.fill('');
        await lbl.type(marca, { delay: 5 });
        filled = true;
      } catch {
        // deu ruim — sem input
      }
    }

    if (!filled) {
      throw new Error('Não foi possível localizar o campo de marca no INPI.');
    }

    // 3) Submeter — tenta botão "Pesquisar" / "Buscar" / o primeiro submit
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
          await Promise.all([
            page.waitForLoadState('domcontentloaded'),
            b.click()
          ]);
          submitted = true;
          break;
        } catch {
          // tenta próximo botão
        }
      }
    }
    if (!submitted) {
      // fallback: press Enter no input
      await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded');
    }

    // 4) Capturar HTML final
    const html = await page.content();
    const processos = parseTabelaHTML(html);

    // 5) Descobrir paginação (se renderizada)
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

/* ============================================================================
 * DECISÃO DE DISPONIBILIDADE (sem lista de alto renome; é detectado pela situação)
 * ========================================================================== */
function decidirDisponibilidade(marcaDigitada, processos) {
  if (!Array.isArray(processos) || processos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro encontrado (busca exata)' };
  }

  const exatos = processos.filter(p => equalsLoose(p.marca || '', marcaDigitada));

  if (exatos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro exato encontrado' };
  }

  const todasTerminais = exatos.every(p => situacaoPermite(p.situacao || ''));
  if (todasTerminais) {
    return { disponivel: true, motivo: 'Todas as situações são terminais (permite registro)' };
  }

  return {
    disponivel: false,
    motivo: 'Há situação(ões) não-terminais (ex.: registro em vigor, Alto Renome, exame, publicação, etc.)'
  };
}

/* ============================================================================
 * HANDLER (POST preferido; GET aceito para compatibilidade com Wix)
 * ========================================================================== */
export default async function handler(req, res) {
  const t0 = Date.now();

  // CORS básicos
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

  try {
    // 1) Tenta o caminho rápido (Cheerio/HTTP)
    let resultado = await tentarCheerio(marcaTrimmed);

    // 2) Se falhar (parâmetros mudaram, sessão exigida, anti-bot etc.), usa Playwright
    if (!resultado || !Array.isArray(resultado.processos)) {
      resultado = await tentarPlaywright(marcaTrimmed);
    }

    // Se ainda assim não veio nada, falha
    if (!resultado || !Array.isArray(resultado.processos)) {
      return res.status(502).json({
        erro: 'Falha ao consultar INPI',
        mensagem: 'Não foi possível extrair resultados da pesquisa'
      });
    }

    const { processos, paginasColetadas, metodo } = resultado;
    const decisao = decidirDisponibilidade(marcaTrimmed, processos);

    // Payload final (sem resumo de processos, como solicitado)
    const resposta = {
      marca: marcaTrimmed,
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
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

    return res.status(200).json(resposta);
  } catch (err) {
    console.error('ERRO scraper INPI', {
      msg: err.message,
      stack: err.stack
    });

    if (err.name === 'TimeoutError') {
      return res.status(504).json({ erro: 'Timeout na consulta ao INPI' });
    }

    return res.status(500).json({ erro: 'Erro interno', mensagem: 'Falha inesperada ao consultar INPI' });
  }
}
