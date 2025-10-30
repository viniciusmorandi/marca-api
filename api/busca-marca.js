import axios from 'axios';
import * as cheerio from 'cheerio';

// === Configurações globais ===
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36'
];

const WIPO_BASE = 'https://branddb.wipo.int/pt/IPO-BR/similarname';
const INPI_URL = 'https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe.jsp';

// === Funções auxiliares ===
function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildWipoAsStructure(marca) {
  return {
    boolean: "AND",
    bricks: [
      { field: "BRAND_NAME", operator: "CONTAINS", value: marca }
    ]
  };
}

async function httpGetWipo(url, cookieJar = '') {
  const headers = {
    'User-Agent': pickUA(),
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    ...(cookieJar ? { 'Cookie': cookieJar } : {})
  };
  const resp = await axios.get(url, { timeout: 15000, headers, validateStatus: () => true });
  return resp;
}

// === WIPO JSON Scraper ===
async function tentarWipo(marca) {
  const pre = await httpGetWipo(`${WIPO_BASE}`);
  const cookieJar = (pre.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  const asStructure = buildWipoAsStructure(marca);
  const qs = new URLSearchParams({
    sort: 'score desc',
    start: '0',
    rows: '30',
    asStructure: JSON.stringify(asStructure)
  });

  const url = `https://branddb.wipo.int/api/search?${qs.toString()}`;
  const headers = {
    'User-Agent': pickUA(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    ...(cookieJar ? { 'Cookie': cookieJar } : {})
  };

  const { status, data } = await axios.get(url, { timeout: 15000, headers, validateStatus: () => true });

  if (!(status >= 200 && status < 300) || typeof data !== 'object') {
    throw new Error(`WIPO JSON HTTP ${status}`);
  }

  const processos = (data?.items || data?.results || []).map(r => ({
    marca: r?.brandName || r?.name || '',
    situacao: r?.statusText || r?.status || '',
    titular: r?.holderName || r?.owner || '',
    classe: Array.isArray(r?.niceClasses) ? r.niceClasses.join(',') : (r?.niceClass || '')
  })).filter(p => p.marca || p.situacao || p.titular || p.classe);

  return { processos, metodo: 'wipo', urlUsada: url };
}

// === INPI Scraper (Cheerio) ===
async function tentarINPI(marca) {
  const url = `https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_resultado.jsp?Texto=${encodeURIComponent(marca)}`;
  const headers = {
    'User-Agent': pickUA(),
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  };
  const { data: html } = await axios.get(url, { headers, timeout: 15000, responseType: 'arraybuffer' });
  const decoded = Buffer.from(html, 'binary').toString('latin1');

  if (typeof decoded === 'string') {
    const processos = parseTabelaINPI(decoded);
    if (processos.length > 0) {
      const $ = cheerio.load(decoded);
      let paginas = 1;
      const rodape = $('body').text();
      const m = rodape.match(/P[áa]ginas de Resultados:\s*([\s\S]*?)$/i);
      if (m) {
        const qtd = (m[1].match(/\d+/g) || []).map(Number);
        const max = Math.max(1, ...qtd);
        if (Number.isFinite(max)) paginas = max;
      }
      return { processos, paginasColetadas: 1, metodo: 'inpi', urlUsada: url, paginasTotal: paginas, rawHtml: decoded };
    }
  }
  return { processos: [], metodo: 'inpi', urlUsada: url, rawHtml: decoded };
}

// === Parser de tabela INPI ===
function parseTabelaINPI(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('table tr').each((_, tr) => {
    const cols = $(tr).find('td');
    if (cols.length >= 4) {
      const marca = $(cols[0]).text().trim();
      const classe = $(cols[1]).text().trim();
      const situacao = $(cols[3]).text().trim();
      if (marca) rows.push({ marca, classe, situacao });
    }
  });
  return rows;
}

// === Decisor de disponibilidade ===
const TERMINAIS_STEMS = [
  'indeferid','negad','arquiv','extint','caducad','cancelad','nulidade procedent','nulo','renunci',
  'expired','cancelled','withdrawn','abandoned'
];

function decidirDisponibilidade(lista) {
  for (const item of lista) {
    const s = (item.situacao || '').toLowerCase();
    const ativa = TERMINAIS_STEMS.every(stem => !s.includes(stem));
    if (ativa) return { disponivel: false, motivo: `Marca ativa: ${item.marca} (${item.situacao})` };
  }
  return { disponivel: true, motivo: 'Nenhuma marca ativa encontrada.' };
}

// === Handler ===
export default async function handler(req, res) {
  try {
    const { marca } = req.body;
    if (!marca) return res.status(400).json({ erro: 'Parâmetro ausente: marca' });
    const marcaTrimmed = marca.trim();

    let resultado = null;

    try {
      // 1️⃣ WIPO JSON
      resultado = await tentarWipo(marcaTrimmed);
    } catch (e) {
      console.warn('Erro WIPO', e.message);
    }

    if (!resultado || !Array.isArray(resultado.processos) || resultado.processos.length === 0) {
      try {
        // 2️⃣ Fallback INPI
        resultado = await tentarINPI(marcaTrimmed);
      } catch (e) {
        console.warn('Erro INPI', e.message);
      }
    }

    if (!resultado || !Array.isArray(resultado.processos) || resultado.processos.length === 0) {
      console.error('DEBUG WIPO/INPI FAIL', {
        htmlSnippet: (resultado && resultado.rawHtml ? String(resultado.rawHtml).slice(0, 600) : '')
      });
      return res.status(502).json({ erro: 'Falha ao consultar bases', mensagem: 'Nenhum resultado encontrado' });
    }

    const decisao = decidirDisponibilidade(resultado.processos);
    return res.status(200).json({ marca: marcaTrimmed, fonte: resultado.metodo, url: resultado.urlUsada, ...decisao, processos: resultado.processos });

  } catch (err) {
    console.error('ERRO GLOBAL', err);
    return res.status(500).json({ erro: 'Erro interno', mensagem: err.message });
  }
}
