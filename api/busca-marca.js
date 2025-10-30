import axios from 'axios';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import iconv from 'iconv-lite';

const INPI_BASE = 'https://busca.inpi.gov.br/pePI';

function makeClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

export async function tentarCheerio(marca) {
  try {
    const client = makeClient();

    // 1. Preflight: cria sessão pegando JSESSIONID
    const preflightUrl = `${INPI_BASE}/jsp/marcas/Pesquisa_classe_basica.jsp`;
    await httpGetHtml(client, preflightUrl);

    // 2. Busca usando a MESMA sessão (cookie-jar)
    const endpoints = [
      (m) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&Marca=${encodeURIComponent(m)}`,
      (m) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&marca=${encodeURIComponent(m)}`,
      (m) => `${INPI_BASE}/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_MARCA_CLASSIF_BASICA&expressao=${encodeURIComponent(m)}`
    ];

    for (const build of endpoints) {
      const url = build(marca);
      const { status, html } = await httpGetHtml(client, url, preflightUrl);

      // Log de diagnóstico
      console.warn('INPI html sample', {
        status,
        snippet: html.slice(0, 200)
      });

      if (status >= 200 && status < 400 && typeof html === 'string') {
        const $ = cheerio.load(html);
        const pageText = $('body').text().toLowerCase();
        const looksLikeResult = pageText.includes('resultado da pesquisa') || $('table').length > 0;

        if (looksLikeResult) {
          // Seu parser padrão!
          const processos = parseTabelaHTML(html); // garanta que sua função está importada ou declarada acima
          // Mesmo sem processos, devolve array vazio (interprete disponível no handler)
          return {
            processos,
            paginasColetadas: 1,
            metodo: 'cheerio',
            paginasTotal: 1,
            urlUsada: url
          };
        }
      }
      // Pequeno backoff se HTTP erro
      if ([429, 500, 502, 503, 504].includes(status)) {
        await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
        continue;
      }
    }

    return null; // Força fallback Playwright (nem sempre precisa)
  } catch (err) {
    console.error('Falha técnica Cheerio:', err);
    return null;
  }
}
