// /api/busca-marca.js
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
 * Schema de resposta
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
 * Consulta Infosimples
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
  if (first?.code !== 200) throw new Error('Erro na resposta Infosimples');

  let blocos = Array.isArray(first.data) ? [...first.data] : [];
  const total = first.data?.[0]?.total_paginas ?? 1;
  for (let p = 2; p <= total; p++) {
    const next = await coletar(p);
    if (next?.code === 200 && Array.isArray(next.data)) blocos.push(...next.data);
  }

  return { code: 200, data: blocos };
}

/* ============================================================================
 * Lógica de decisão: disponível x indisponível
 * ========================================================================== */
function decidirDisponibilidade(marcaDigitada, processos) {
  if (!Array.isArray(processos) || processos.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro encontrado (busca exata)', processos: [] };
  }

  const nomeCanonico = canonical(marcaDigitada);
  const exatosOuParecidos = processos.filter(p => equalsLoose(p.marca || '', marcaDigitada));

  // ⚠️ Se não encontrou “exatos”, tenta “quase iguais” (sem espaços)
  const proximos = processos.filter(p => canonical(p.marca || '').includes(nomeCanonico));

  const relevantes = [...new Set([...exatosOuParecidos, ...proximos])];
  if (relevantes.length === 0) {
    return { disponivel: true, motivo: 'Nenhum registro exato encontrado', processos: [] };
  }

  const processosOut = relevantes.map(p => ({
    numero: (p.numero ?? p.processo ?? '').toString(),
    situacao: getSituacao(p),
    titular: p.titular || '',
    classe: (p.classe || p.classe_nice || '').toString()
  }));

  // ❗️Se qualquer um dos processos não for terminal, já bloqueia
  const algumAtivo = relevantes.some(p => !situacaoPermite(getSituacao(p)));
  if (algumAtivo) {
    return {
      disponivel: false,
      motivo: 'Há registros em vigor ou em andamento que impedem novo pedido.',
      processos: processosOut
    };
  }

  return {
    disponivel: true,
    motivo: 'Todas as situações são terminais (permite registro)',
    processos: processosOut
  };
}

/* ============================================================================
 * Handler principal (Next.js)
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
    return res.status(502).json({
      erro: 'Falha na consulta ao INPI',
      mensagem: err.message
    });
  }
}
