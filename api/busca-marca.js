import axios from 'axios';
import Ajv from 'ajv';

/* ============================================================================
 * Helpers de normalização e decisão
 * ========================================================================== */
const normalize = (s = '') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

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
  }
};

const ajv = new Ajv();
const validateResponse = ajv.compile(RESPONSE_SCHEMA);

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

/* ============================================================================
 * Mock Data para testes (usado quando MOCK_INFOSIMPLES=true)
 * ========================================================================== */
const MOCK_DATA = {
  'natura': {
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
      ]
    }],
    total_paginas: 1
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
      ]
    }],
    total_paginas: 1
  },
  'xyzminhamarca2025': {
    code: 200,
    data: [{ processos: [] }],
    total_paginas: 1
  }
};

/** true se a situação é terminal (permite novo registro) */
const situacaoPermite = (situacao = '') => {
  const s = normalize(situacao);
  return TERMINAIS_STEMS.some(stem => s.includes(stem));
};

/** Extrai todos os processos de um resultado Infosimples (data = array de blocos) */
const extrairProcessos = (resultado) => {
  if (!resultado || !Array.isArray(resultado.data)) return [];
  return resultado.data.flatMap(b => (Array.isArray(b.processos) ? b.processos : []));
};

/** Aplica a regra simplificada de disponibilidade */
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

  if (todasTerminais) {
    return {
      disponivel: true,
      motivo: 'Todas as situações são terminais',
      processos: exatos.map(p => ({
        numero: p.numero || p.processo || '',
        situacao: p.situacao || p.situacao_processual || p.status || '',
        titular: p.titular || '',
        classe: p.classe || p.classe_nice || ''
      }))
    };
  }

  return {
    disponivel: false,
    motivo: 'Marca com situação(ões) não-terminal(is)',
    processos: exatos.map(p => ({
      numero: p.numero || p.processo || '',
      situacao: p.situacao || p.situacao_processual || p.status || '',
      titular: p.titular || '',
      classe: p.classe || p.classe_nice || ''
    }))
  };
}

/* ============================================================================
 * Função principal: consulta o INPI via Infosimples (TODAS as páginas)
 * ========================================================================== */
async function consultarINPI_TodasPaginas(marca) {
  const token = process.env.INFOSIMPLES_TOKEN;
  if (!token) throw new Error('Token Infosimples não configurado');

  const url = 'https://api.infosimples.com/api/v2/consultas/inpi/marcas';
  const params = {
    termo: marca,
    tipo: 'exata',    // SEMPRE busca exata (Rule 1)
    token
  };

  let paginaAtual = 1;
  let totalPaginas = 1;
  let todosProcessos = [];

  do {
    const response = await axios.get(url, {
      params: { ...params, pagina: paginaAtual },
      timeout: 15000    // 15 segundos (corrigido)
    });

    const { code, data } = response.data;

    // Rule 3: HTTP errors
    if (code !== 200) {
      throw { customStatus: 502, message: `Infosimples retornou code ${code}` };
    }

    // Extrai processos desta página
    const processosPagina = extrairProcessos(response.data);
    todosProcessos = todosProcessos.concat(processosPagina);

    // Verifica se há mais páginas (Rule 5)
    totalPaginas = response.data.total_paginas || 1;
    paginaAtual++;

  } while (paginaAtual <= totalPaginas);

  return {
    processos: todosProcessos,
    paginasColetadas: totalPaginas
  };
}

/* ============================================================================
 * Handler da API (Next.js)
 * ========================================================================== */
export default async function handler(req, res) {
  const startTime = Date.now();

  try {
    const { marca } = req.query;

    if (!marca || typeof marca !== 'string') {
      return res.status(400).json({ erro: 'Parâmetro "marca" obrigatório' });
    }

    let processos = [];
    let paginasColetadas = 1;

    // Verifica se deve usar mock data
    if (process.env.MOCK_INFOSIMPLES === 'true') {
      const mockKey = normalize(marca);
      const mockResponse = MOCK_DATA[mockKey];

      if (mockResponse) {
        processos = extrairProcessos(mockResponse);
        paginasColetadas = mockResponse.total_paginas;
      }
    } else {
      // Consulta real
      const resultado = await consultarINPI_TodasPaginas(marca);
      processos = resultado.processos;
      paginasColetadas = resultado.paginasColetadas;
    }

    // Decisão de disponibilidade (Rule 2)
    const decisao = decidirDisponibilidade(marca, processos);

    // Monta resposta final (Rule 6)
    const resposta = {
      marca,
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
      processos: decisao.processos,
      metadata: {
        fonte: 'INPI',
        tipo_busca: 'exata',
        timestamp: new Date().toISOString(),
        tempo_resposta_ms: Date.now() - startTime,
        paginas_coletadas: paginasColetadas
      }
    };

    // Validação com Ajv antes de enviar
    if (!validateResponse(resposta)) {
      console.error('Erro de validação:', validateResponse.errors);
      return res.status(500).json({ erro: 'Formato de resposta inválido' });
    }

    return res.status(200).json(resposta);

  } catch (err) {
    console.error('[ERRO]', err);

    // Rule 3: Error handling
    if (err.customStatus) {
      return res.status(err.customStatus).json({ erro: err.message });
    }
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return res.status(504).json({ erro: 'Timeout na consulta ao INPI' });
    }

    return res.status(500).json({ erro: 'Erro interno ao processar consulta' });
  }
}

/* ============================================================================
 * Testes automatizados (executar com MOCK_INFOSIMPLES=true)
 * ========================================================================== */
export async function runTests() {
  console.log('\n========== INICIANDO TESTES AUTOMATIZADOS ==========\n');
  
  const originalMock = process.env.MOCK_INFOSIMPLES;
  process.env.MOCK_INFOSIMPLES = 'true';

  const tests = [
    { marca: 'NATURA', expectedDisponivel: false },
    { marca: 'COCA-COLA', expectedDisponivel: false },
    { marca: 'XYZMINHAMARCA2025', expectedDisponivel: true }
  ];

  for (const test of tests) {
    try {
      const mockReq = { query: { marca: test.marca } };
      const mockRes = {
        status: (code) => ({
          json: (data) => ({ statusCode: code, body: data })
        })
      };

      const result = await handler(mockReq, mockRes);
      const disponivel = result.body.disponivel;
      const passed = disponivel === test.expectedDisponivel;
      
      console.log(`[TEST] ${test.marca} → disponivel=${disponivel} ${passed ? '✅' : '❌'}`);
      if (!passed) {
        console.error(`  FALHOU: esperado=${test.expectedDisponivel}, recebido=${disponivel}`);
      }
    } catch (error) {
      console.error(`[TEST] ${test.marca} → ERRO ❌`, error.message);
    }
  }

  process.env.MOCK_INFOSIMPLES = originalMock;
  console.log('\n========== TESTES CONCLUÍDOS ==========\n');
}
