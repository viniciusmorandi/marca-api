// /api/busca-marca.js
import axios from 'axios';
import Ajv from 'ajv';

/* ============================================================================
 * Normalização e utilidades de comparação
 * ========================================================================== */
const stripDiacriticsLower = (s = '') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// remove tudo que não for letra/dígito (une palavras): "túnel crew" -> "tunelcrew"
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
  'indeferid',           // indeferida/indeferido
  'negad',               // negada/negado
  'arquiv',              // arquivada/arquivado/arquivamento/pedido definitivamente arquivado
  'extint',              // extinta/extinto/registro de marca extinto
  'caducad',             // caducada/caducado
  'cancelad',            // cancelada/cancelado
  'nulidade procedent',  // nulidade procedente
  'nulo',                // nulo
  'renunci'              // renúncia/renuncia (total)
];

// Retorna true se a situação é terminal (permite registro)
const situacaoPermite = (situacao = '') => {
  const s = stripDiacriticsLower(situacao);
  return TERMINAIS_STEMS.some(stem => s.includes(stem));
};

// Extrai o melhor campo de situação dentre possíveis chaves
const getSituacao = (proc = {}) =>
  proc.situacao ||
  proc.situacao_processual ||
  proc.status ||
  proc.registro || // às vezes o Infosimples manda "Marca Registrada" / "Marca Arquivada" aqui
  '';

/* ============================================================================
 * Schema da resposta (Ajv)
 * ========================================================================== */
const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['marca', 'disponivel', 'motivo', 'processos', 'metadata'],
  additionalProperties: false,
  properties: {
    marca: { type: 'string' },
    disponivel: { type: 'boolean' },
    motivo: { type: 'string' },
    processos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['numero', 'situacao', 'titular', 'classe'],
        additionalProperties: false,
        properties: {
          numero: { type: 'string' },
          situacao: { type: 'string' },
          titular: { type: 'string' },
          classe: { type: 'string' }
        }
      }
    },
    metadata: {
      type: 'object',
      required: ['fonte', 'tipo_busca', 'timestamp', 'tempo_resposta_ms', 'paginas_coletadas'],
      additionalProperties: false,
      properties: {
        fonte: { type: 'string' },
        tipo_busca: { type: 'string' },
        timestamp: { type: 'string' },
        tempo_resposta_ms: { type: 'number' },
        paginas_coletadas: { type: 'number' }
      }
    }
  }
};

const ajv = new Ajv({ allErrors: true });
const validateResponse = ajv.compile(RESPONSE_SCHEMA);

/* ============================================================================
 * MOCK para testes offline (MOCK_INFOSIMPLES=true)
 * ========================================================================== */
const MOCK_DATA = {
  natura: {
    code: 200,
    data: [{
      processos: [
        { numero: '900000001', marca: 'NATURA', situacao: 'Registro de marca em vigor', titular: 'Natura Cosméticos S.A.', classe: '03' },
        { numero: '900000002', marca: 'NATURA', situacao: 'Alto Renome', titular: 'Natura Cosméticos S.A.', classe: '03' }
      ],
      total_paginas: 1
    }]
  },
  'coca-cola': {
    code: 200,
    data: [{
      processos: [
        { numero: '900000003', marca: 'COCA-COLA', situacao: 'Alto Renome', titular: 'The Coca-Cola Company', classe: '32' }
      ],
      total_paginas: 1
    }]
  },
  xyzminhamarca2025: {
    code: 200,
    data: [{ processos: [], total_paginas: 1 }]
  },
  // caso citado: Túnel Crew
  'tunel crew': {
    code: 200,
    data: [{
      processos: [
        { numero: '915021196', marca: 'Túnel Crew', situacao: 'Registro de marca em vigor', titular: 'ANGELO ANTONIO MESQUITA BITTAR', classe: 'NCL(11) 25' },
        { numero: '915022397', marca: 'Túnel Crew', situacao: 'Pedido definitivamente arquivado', titular: 'ANGELO ANTONIO MESQUITA BITTAR', classe: 'NCL(11) 41' }
      ],
      total_paginas: 1
    }]
  }
};

/* ============================================================================
 * Parsing e paginação
 * ========================================================================== */
const extrairProcessos = (resultado) => {
  if (!resultado || !Array.isArray(resultado.data)) return [];
  return resultado.data.flatMap(b => (Array.isArray(b.processos) ? b.processos : []));
};

const extrairTotalPaginas = (resultado) => {
  if (!resultado) return 1;
  const fromBlock = Array.isArray(resultado.data) ? resultado.data[0]?.total_paginas : undefined;
  if (typeof fromBlock === 'number' && fromBlock >= 1) return fromBlock;
  if (typeof resultado.total_paginas === 'number' && resultado.total_paginas >= 1) return resultado.total_paginas;
  return 1;
};

/* ============================================================================
 * Infosimples — POST + paginação (sempre tipo='exata')
 * ========================================================================== */
async function consultarINPI_TodasPaginas(marca) {
  const token = process.env.INFOSIMPLES_TOKEN;
  if (!token) {
    const e = new Error('Token Infosimples não configurado');
    e.code = 'CONFIG';
    throw e;
  }

  // MOCK para testes locais
  if (process.env.MOCK_INFOSIMPLES === 'true') {
    const key = stripDiacriticsLower(marca);
    const mock = MOCK_DATA[key] || MOCK_DATA[canonical(marca)] || null;
    if (!mock) return { data: [{ processos: [], total_paginas: 1 }], code: 200 };
    return mock;
  }

  const url = 'https://api.infosimples.com/api/v2/consultas/inpi/marcas';
  const headers = { 'Content-Type': 'application/json' };

  const coletar = async (pagina = 1) => {
    const { data } = await axios.post(
      url,
      { token, marca, tipo: 'exata', pagina },
      { headers, timeout: 15000 }
    );
    return data; // { code, data:[{ processos, total_paginas }], ... }
  };

  // Página 1
  const first = await coletar(1);
  if (first?.code && first.code !== 200) {
    const e = new Error(`Infosimples erro (${first.code}): ${first.code_message || 'indisponível'}`);
    e.code = 'UPSTREAM';
    e.upstream = first;
    throw e;
  }

  let blocos = Array.isArray(first?.data) ? [...first.data] : [];
  const totalPaginas = extrairTotalPaginas(first);

  // Demais páginas
  for (let p = 2; p <= totalPaginas; p++) {
    const page = await coletar(p);
    if (page?.code && page.code !== 200) {
      const e = new Error(`Infosimples erro pág ${p} (${page.code}): ${page.code_message || 'indisponível'}`);
      e.code = 'UPSTREAM';
      e.upstream = page;
      throw e;
    }
    if (Array.isArray(page?.data)) blocos = blocos.concat(page.data);
  }

  return { data: blocos, code: 200 };
}

/* ============================================================================
 * Decisão de disponibilidade
 * ========================================================================== */
function decidirDisponibilidade(marcaDigitada, processos) {
  // 1) Sem processos ⇒ disponível
  if (!Array.isArray(processos) || processos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro encontrado (busca exata)', processos: [] };
    }
  // 2) Match "exato" tolerante (acentos/case/espaço/pontuação)
  const exatos = processos.filter(p => equalsLoose(p.marca || '', marcaDigitada));

  if (exatos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro exato encontrado', processos: [] };
  }

  // 3) Se TODAS as situações forem terminais ⇒ disponível; senão ⇒ indisponível
  const todasTerminais = exatos.every(p => situacaoPermite(getSituacao(p)));

  const processosOut = exatos.map(p => ({
    numero: (p.numero ?? p.processo ?? '').toString(),
    situacao: getSituacao(p),
    titular: p.titular || '',
    classe: (p.classe || p.classe_nice || '').toString()
  }));

  if (todasTerminais) {
    return { disponivel: true, motivo: 'Todas as situações são terminais (permite registro)', processos: processosOut };
  }

  return {
    disponivel: false,
    motivo: 'Há situação(ões) não-terminais (registro em vigor, Alto Renome, exame, publicação, etc.)',
    processos: processosOut
  };
}

/* ============================================================================
 * Handler (Next.js / Vercel) — POST (aceita GET por segurança)
 * ========================================================================== */
export default async function handler(req, res) {
  const t0 = Date.now();

  // CORS básicos
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Aceita POST (padrão) e GET (fallback do Wix, se vier)
  const metodoValido = req.method === 'POST' || req.method === 'GET';
  if (!metodoValido) {
    return res.status(405).json({ erro: 'Método não permitido', mensagem: 'Use POST (ou GET com marca em query)' });
  }

  const marca = (req.method === 'POST' ? req.body?.marca : req.query?.marca) ?? '';
  if (!marca || typeof marca !== 'string' || marca.trim() === '') {
    return res.status(422).json({ erro: 'Validação falhou', mensagem: 'O campo "marca" é obrigatório e deve ser uma string não vazia' });
  }
  const marcaTrimmed = marca.trim();

  try {
    // 1) Consultar Infosimples (com mock se habilitado)
    const bruto = await consultarINPI_TodasPaginas(marcaTrimmed);

    // Upstream com erro (garantia extra)
    if (bruto?.code && bruto.code !== 200) {
      return res.status(502).json({
        erro: 'Erro ao consultar INPI',
        mensagem: bruto.code_message || 'Serviço indisponível'
      });
    }

    // 2) Extrair e decidir
    const processos = extrairProcessos(bruto);
    const decisao = decidirDisponibilidade(marcaTrimmed, processos);

    // 3) Montar resposta final
    const resposta = {
      marca: marcaTrimmed,
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
      processos: decisao.processos,
      metadata: {
        fonte: 'INPI',
        tipo_busca: 'exata',
        timestamp: new Date().toISOString(),
        tempo_resposta_ms: Date.now() - t0,
        paginas_coletadas: extrairTotalPaginas(bruto)
      }
    };

    // 4) Validar schema antes de enviar
    if (!validateResponse(resposta)) {
      console.error('Ajv errors:', validateResponse.errors);
      return res.status(500).json({ erro: 'Formato de resposta inválido' });
    }

    return res.status(200).json(resposta);
  } catch (err) {
    console.error('ERRO', {
      msg: err.message,
      code: err.code,
      upstream: err.upstream?.code,
      upstream_msg: err.upstream?.code_message
    });

    if (err.code === 'UPSTREAM' || err?.response) {
      return res.status(502).json({
        erro: 'Erro ao consultar INPI',
        mensagem: err.upstream?.code_message || err.response?.data?.message || err.message
      });
    }
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return res.status(504).json({ erro: 'Timeout na consulta ao INPI' });
    }
    if (err.code === 'CONFIG') {
      return res.status(500).json({ erro: 'Configuração', mensagem: err.message });
    }
    return res.status(500).json({ erro: 'Erro interno', mensagem: 'Falha inesperada' });
  }
}

/* ============================================================================
 * Testes (rodar local com MOCK_INFOSIMPLES=true)
 * node -e "import('./api/busca-marca.js').then(m=>m.runTests())"
 * ========================================================================== */
export async function runTests() {
  const original = process.env.MOCK_INFOSIMPLES;
  process.env.MOCK_INFOSIMPLES = 'true';

  const makeRes = () => {
    let statusCode = 200;
    return {
      _result: null,
      setHeader() {},
      status(code) { statusCode = code; return this; },
      json(payload) {
        this._result = { statusCode, body: payload };
        return this._result; // facilita assert
      }
    };
  };

  const tests = [
    { name: 'NATURA', expected: false },
    { name: 'COCA-COLA', expected: false },
    { name: 'XYZMINHAMARCA2025', expected: true },
    { name: 'Túnel Crew', expected: false } // caso citado
  ];

  console.log('\n========== INICIANDO TESTES (MOCK) ==========');
  for (const t of tests) {
    const req = { method: 'POST', body: { marca: t.name } };
    const res = makeRes();
    const out = await handler(req, res);
    const result = res._result || out; // compat
    const ok = result?.body?.disponivel === t.expected;
    console.log(`[TEST] ${t.name} → disponivel=${result?.body?.disponivel} ${ok ? '✅' : '❌'}`);
    if (!ok) console.error('  Esperado:', t.expected, ' Recebido:', result?.body?.disponivel, ' Status:', result?.statusCode);
  }
  console.log('========== TESTES CONCLUÍDOS ==========\n');

  process.env.MOCK_INFOSIMPLES = original;
}
