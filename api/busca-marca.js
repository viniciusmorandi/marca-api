import axios from 'axios';
import Ajv from 'ajv';

/* ============================================================================
 * Normalização e comparação tolerante
 * ========================================================================== */
const stripDiacriticsLower = (s = '') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Remove tudo que não for letra/dígito: "túnel crew" → "tunelcrew"
const canonical = (s = '') => stripDiacriticsLower(s).replace(/[^a-z0-9]+/g, '');

// Compara nomes de marca de forma tolerante
const equalsLoose = (a = '', b = '') => {
  const A = canonical(a);
  const B = canonical(b);
  if (!A || !B) return false;
  return (
    A === B ||
    A.includes(B) ||
    B.includes(A) ||
    // diferença leve, como “mercadolivre” vs “mercado livre”
    A.replace(/\s+/g, '') === B.replace(/\s+/g, '')
  );
};

/* ============================================================================
 * Situações TERMINAIS (qualquer outra => INDISPONÍVEL)
 * ========================================================================== */
const TERMINAIS_STEMS = [
  'indeferid',
  'negad',
  'arquiv',
  'extint',
  'caducad',
  'cancelad',
  'nulidade procedent',
  'nulo',
  'renunci'
];

const situacaoPermite = (situacao = '') => {
  const s = stripDiacriticsLower(situacao);
  return TERMINAIS_STEMS.some(stem => s.includes(stem));
};

const getSituacao = (proc = {}) =>
  proc.situacao ||
  proc.situacao_processual ||
  proc.status ||
  proc.registro ||
  '';

/* ============================================================================
 * Schema de resposta (validação Ajv)
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
        },
        required: ['numero', 'situacao', 'titular', 'classe']
      }
    },
    metadata: {
      type: 'object',
      properties: {
        fonte: { type: 'string' },
        tipo_busca: { type: 'string' },
        timestamp: { type: 'string' },
        tempo_resposta_ms: { type: 'number' },
        paginas_coletadas: { type: 'number' }
      },
      required: ['fonte', 'tipo_busca', 'timestamp', 'tempo_resposta_ms', 'paginas_coletadas']
    }
  }
};

const ajv = new Ajv({ allErrors: true });
const validateResponse = ajv.compile(RESPONSE_SCHEMA);

/* ============================================================================
 * Consulta ao INPI via Infosimples
 * ========================================================================== */
async function consultarINPI_TodasPaginas(marca) {
  const token = process.env.INFOSIMPLES_TOKEN;
  if (!token) throw new Error('Token Infosimples não configurado');

  const url = 'https://api.infosimples.com/api/v2/consultas/inpi/marcas';
  const headers = { 'Content-Type': 'application/json' };

  const coletar = async (pagina = 1) => {
    const { data } = await axios.post(
      url,
      { token, marca, tipo: 'exata', pagina },
      { headers, timeout: 20000 }
    );
    return data;
  };

  const first = await coletar(1);

  // ⚠️ TRATAMENTO ESPECIAL: INPI fora do ar ou sem retorno
  if (first?.code === 612 || first?.code === 615) {
    const e = new Error('INPI fora do ar ou sem retorno de dados');
    e.code = 'INPI_DOWN';
    e.details = first?.code_message;
    throw e;
  }

  if (first?.code !== 200) {
    const e = new Error(`Erro Infosimples: ${first?.code_message || 'indefinido'}`);
    e.code = 'UPSTREAM';
    throw e;
  }

  let blocos = Array.isArray(first.data) ? [...first.data] : [];
  const total = first.data?.[0]?.total_paginas ?? 1;
  for (let p = 2; p <= total; p++) {
    const next = await coletar(p);
    if (next?.code === 200 && Array.isArray(next.data)) blocos.push(...next.data);
  }

  return { code: 200, data: blocos };
}

/* ============================================================================
 * Lógica de decisão de disponibilidade
 * ========================================================================== */
function decidirDisponibilidade(marcaDigitada, processos) {
  if (!Array.isArray(processos) || processos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro encontrado (busca exata)', processos: [] };
  }

  const nomeCanonico = canonical(marcaDigitada);
  const relevantes = processos.filter(p =>
    equalsLoose(p.marca || '', marcaDigitada) ||
    canonical(p.marca || '').includes(nomeCanonico)
  );

  if (relevantes.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro exato encontrado', processos: [] };
  }

  // Se qualquer um dos processos não for terminal, já bloqueia
  const algumAtivo = relevantes.some(p => !situacaoPermite(getSituacao(p)));
  if (algumAtivo) {
    return {
      disponivel: false,
      motivo: 'Há registros em vigor ou em andamento que impedem novo pedido.',
      processos: [] // ✅ Resumo removido conforme solicitado
    };
  }

  return {
    disponivel: true,
    motivo: 'Todas as situações são terminais (permite registro)',
    processos: [] // ✅ Resumo removido conforme solicitado
  };
}

/* ============================================================================
 * Handler principal (Next.js / Vercel)
 * ========================================================================== */
export default async function handler(req, res) {
  const inicio = Date.now();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const marca = (req.body?.marca || req.query?.marca || '').trim();
  if (!marca) {
    return res.status(400).json({ erro: 'Campo "marca" é obrigatório' });
  }

  try {
    const bruto = await consultarINPI_TodasPaginas(marca);
    const processos = bruto.data?.flatMap(d => d.processos || []) || [];
    const decisao = decidirDisponibilidade(marca, processos);

    const resposta = {
      marca,
      disponivel: decisao.disponivel,
      motivo: decisao.motivo,
      processos: decisao.processos,
      metadata: {
        fonte: 'INPI via Infosimples',
        tipo_busca: 'exata',
        timestamp: new Date().toISOString(),
        tempo_resposta_ms: Date.now() - inicio,
        paginas_coletadas: bruto.data?.length || 1
      }
    };

    if (!validateResponse(resposta)) {
      console.error('Schema inválido:', validateResponse.errors);
      return res.status(500).json({ erro: 'Formato inválido da resposta' });
    }

    return res.status(200).json(resposta);

  } catch (err) {
    console.error('Erro ao consultar:', err.message);

    if (err.code === 'INPI_DOWN') {
      return res.status(503).json({
        marca,
        disponivel: false,
        motivo: '⚠️ O site do INPI está instável ou não retornou resultados. Tente novamente em alguns minutos.'
      });
    }

    if (err.code === 'UPSTREAM') {
      return res.status(502).json({
        marca,
        disponivel: false,
        motivo: `Erro na comunicação com o Infosimples (${err.message})`
      });
    }

    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return res.status(504).json({
        marca,
        disponivel: false,
        motivo: '⏱️ Tempo de resposta do INPI excedido. Tente novamente.'
      });
    }

    return res.status(500).json({
      marca,
      disponivel: false,
      motivo: '❌ Erro interno ao processar consulta. Tente novamente.'
    });
  }
}
