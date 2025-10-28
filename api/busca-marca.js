// /api/busca-marca.js
import axios from 'axios';
import Ajv from 'ajv';

/* ============================================================================
 * Helpers de normalização e decisão
 * ========================================================================== */
const normalize = (s = '') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Stems de situações TERMINAIS (qualquer outra => INDISPONÍVEL) */
const TERMINAIS_STEMS = [
  'indeferid',              // indeferida/indeferido
  'negad',                  // negada/negado
  'arquiv',                 // arquivada/arquivado/arquivamento
  'extint',                 // extinta/extinto/registro de marca extinto
  'caducad',                // caducada/caducado
  'cancelad',               // cancelada/cancelado
  'nulidade procedent',     // nulidade procedente
  'nulo',                   // nulo
  'renunci'                 // renúncia/renuncia (total)
];

/** true se a situação é terminal (permite novo registro) */
const situacaoPermite = (situacao = '') => {
  const s = normalize(situacao);
  return TERMINAIS_STEMS.some(stem => s.includes(stem));
};

/* ============================================================================
 * Schema de validação da resposta (Ajv)
 * ========================================================================== */
const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['marca', 'disponivel', 'motivo', 'processos', 'metadata'],
  properties: {
    marca: { type: 'string' },
    disponivel: { type: 'boolean' },
    motivo: { type: 'string' },
    processos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['numero', 'situacao', 'titular', 'classe'],
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
      properties: {
        fonte: { type: 'string' },
        tipo_busca: { type: 'string' },
        timestamp: { type: 'string' },
        tempo_resposta_ms: { type: 'number' },
        paginas_coletadas: { type: 'number' }
      }
    }
  },
  additionalProperties: false
};

const ajv = new Ajv({ allErrors: true });
const validateResponse = ajv.compile(RESPONSE_SCHEMA);

/* ============================================================================
 * Mock Data para testes (usado quando MOCK_INFOSIMPLES=true)
 * ========================================================================== */
const MOCK_DATA = {
  natura: {
    code: 200,
    data: [{
      processos: [
        {
          numero: '900000001',
          marca: 'NATURA',
          situacao: 'Registro de marca em vigor',
          titular: 'Natura Cosméticos S.A.',
          classe: '03'
        },
        {
          numero: '900000002',
          marca: 'NATURA',
          situacao: 'Alto Renome',
          titular: 'Natura Cosméticos S.A.',
          classe: '03'
        }
      ],
      total_paginas: 1
    }]
  },
  'coca-cola': {
    code: 200,
    data: [{
      processos: [
        {
          numero: '900000003',
          marca: 'COCA-COLA',
          situacao: 'Alto Renome',
          titular: 'The Coca-Cola Company',
          classe: '32'
        }
      ],
      total_paginas: 1
    }]
  },
  xyzminhamarca2025: {
    code: 200,
    data: [{
      processos: [],
      total_paginas: 1
    }]
  }
};

/* ============================================================================
 * Utilidades de parsing/paginação
 * ========================================================================== */
const extrairProcessos = (resultado) => {
  if (!resultado || !Array.isArray(resultado.data)) return [];
  return resultado.data.flatMap(b => (Array.isArray(b.processos) ? b.processos : []));
};

const extrairTotalPaginas = (resultado) => {
  if (!resultado) return 1;
  // preferir dentro do bloco
  const fromBlock = Array.isArray(resultado.data) && resultado.data[0]?.total_paginas;
  if (typeof fromBlock === 'number') return fromBlock || 1;
  // fallback (alguns mocks/versões trazem no topo)
  if (typeof resultado.total_paginas === 'number') return resultado.total_paginas || 1;
  return 1;
};

/* ============================================================================
 * Consulta ao INPI via Infosimples — POST + paginação (sempre tipo=exata)
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
      { token, marca, tipo: 'exata', pagina },                // SEMPRE e SÓ EXATA
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return data; // { code, code_message, data:[{ processos, total_paginas }], ... }
  };

  // Página 1
  const first = await coletarPagina(1);
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
    const page = await coletarPagina(p);
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
 * Regras de decisão
 * ========================================================================== */
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

  const processosOut = exatos.map(p => ({
    numero: (p.numero ?? p.processo ?? '').toString(),
    situacao: p.situacao || p.situacao_processual || p.status || '',
    titular: p.titular || '',
    classe: p.classe || p.classe_nice || ''
  }));

  if (todasTerminais) {
    return {
      disponivel: true,
      motivo: 'Todas as situações são terminais',
      processos: processosOut
    };
  }

  return {
    disponivel: false,
    motivo: 'Há situação(ões) não-terminais (registro ativo, Alto Renome, exame, publicação, etc.)',
    processos: processosOut
  };
}

/* ============================================================================
 * Handler da API (Next.js / Vercel) — usa POST
 * ========================================================================== */
export default async function handler(req, res) {
  const t0 = Date.now();

  // CORS básicos (opcional)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido', mensagem: 'Use POST para consultar marcas' });
  }

  const { marca } = req.body || {};
  if (!marca || typeof marca !== 'string' || marca.trim() === '') {
    return res.status(422).json({ erro: 'Validação falhou', mensagem: 'O campo "marca" é obrigatório e deve ser uma string não vazia' });
  }
  const marcaTrimmed = marca.trim();

  try {
    let processos = [];
    let paginasColetadas = 1;

    if (process.env.MOCK_INFOSIMPLES === 'true') {
      const mockKey = normalize(marcaTrimmed);
      const mock = MOCK_DATA[mockKey];
      if (!mock) {
        return res.status(200).json({
          marca: marcaTrimmed,
          disponivel: true,
          motivo: 'Nenhum registro encontrado (mock)',
          processos: [],
          metadata: {
            fonte: 'INPI',
            tipo_busca: 'exata',
            timestamp: new Date().toISOString(),
            tempo_resposta_ms: Date.now() - t0,
            paginas_coletadas: 1
          }
        });
      }
      processos = extrairProcessos(mock);
      paginasColetadas = extrairTotalPaginas(mock);
    } else {
      const resultado = await consultarINPI_TodasPaginas(marcaTrimmed);
      processos = extrairProcessos(resultado);
      paginasColetadas = extrairTotalPaginas(resultado);
    }

    const decisao = decidirDisponibilidade(marcaTrimmed, processos);

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
        paginas_coletadas: paginasColetadas
      }
    };

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
 * Testes automatizados (executar com MOCK_INFOSIMPLES=true)
 * node -e "import('./api/busca-marca.js').then(m=>m.runTests())"
 * ========================================================================== */
export async function runTests() {
  const original = process.env.MOCK_INFOSIMPLES;
  process.env.MOCK_INFOSIMPLES = 'true';

  const makeRes = () => {
    let statusCode = 200;
    return {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        // Retorna um objeto que o runner consegue inspecionar
        return { statusCode, body: payload };
      },
      setHeader() {} // no-op para CORS nos testes
    };
  };

  const tests = [
    { nome: 'NATURA', esperado: false },
    { nome: 'COCA-COLA', esperado: false },
    { nome: 'XYZMINHAMARCA2025', esperado: true }
  ];

  console.log('\n========== INICIANDO TESTES (MOCK) ==========');
  for (const t of tests) {
    const req = { method: 'POST', body: { marca: t.nome } };
    const res = makeRes();
    const result = await handler(req, res); // nosso handler retorna o objeto do res.json no mock
    const ok = result?.body?.disponivel === t.esperado;
    console.log(`[TEST] ${t.nome} → disponivel=${result?.body?.disponivel} ${ok ? '✅' : '❌'}`);
    if (!ok) {
      console.error('  Esperado:', t.esperado, ' Recebido:', result?.body?.disponivel, ' Status:', result?.statusCode);
    }
  }
  console.log('========== TESTES CONCLUÍDOS ==========\n');

  process.env.MOCK_INFOSIMPLES = original;
}
