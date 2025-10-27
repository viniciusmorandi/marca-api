import axios from 'axios';

// Função para normalizar texto (apenas lowercase e trim, SEM remover acentos)
function normalizar(texto) {
  if (!texto) return '';
  return texto.toLowerCase().trim();
}

// Função para remover diacríticos/acentos (APENAS para comparações internas)
function removerDiacriticos(texto) {
  if (!texto) return '';
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Verifica se situação é considerada ATIVA/VIGENTE (BLOQUEIA novo registro)
function isSituacaoAtiva(situacao) {
  const s = normalizar(situacao || '');
  const bloqueiaRegistro = [
    'concedida', 'concessao',
    'registrada', 'registro',
    'ativa', 'vigente', 'vigencial',
    'deferida',
    'publicada',
    'alto renome',
  ];
  return bloqueiaRegistro.some(term => s.includes(term));
}

// Verifica se situação é considerada PROVISÓRIA (ainda BLOQUEIA novo registro)
function isSituacaoProvisoria(situacao) {
  const s = normalizar(situacao || '');
  const bloqueiaProvisorio = [
    'em exame',
    'em andamento',
    'sobrestado',
    'suspenso',
    'aguardando',
    'pendente',
    'depositada',
    'exigencia',
    'oposicao',
    'em recurso',
  ];
  return bloqueiaProvisorio.some(term => s.includes(term));
}

// Verifica se situação é considerada TERMINAL (NÃO bloqueia novo registro)
function isSituacaoTerminal(situacao) {
  const s = normalizar(situacao || '');
  const permiteRegistro = [
    'arquivada', 'arquivamento',
    'extinta',
    'indeferida', 'negada', 'negado',
    'caducada', 'caducado',
    'cancelada', 'cancelado',
    'renunciada',
  ];
  return permiteRegistro.some(term => s.includes(term));
}

// Lista de marcas de ALTO RENOME (Portaria INPI 181/2024)
// Atualizada em: 2025-01-15
const MARCAS_ALTO_RENOME = [
  'coca-cola',
  'disney',
  'hollywood',
  'mcdonalds',
  'nike',
  'pepsi',
  'microsoft',
  'apple',
  'google',
  'amazon',
  'facebook',
  'adidas',
  'puma',
  'mercedes-benz',
  'bmw',
  'ferrari',
  'porsche',
  'rolex',
  'chanel',
  'louis vuitton',
  'gucci',
  'prada',
  'versace',
  'armani',
  'cartier',
  'tiffany',
  'starbucks',
  'subway',
  'burger king',
  'pizza hut',
  'kfc',
  'nestle',
  'unilever',
  'procter & gamble',
  'johnson & johnson',
  'sony',
  'samsung',
  'lg',
  'panasonic',
  'philips',
  'siemens',
  'general electric',
  'ibm',
  'intel',
  'oracle',
  'cisco',
  'hp',
  'dell',
  'canon',
  'nikon',
  'fujifilm',
];

// Função auxiliar: calcular prioridade de bloqueio
function calcularPrioridade(situacao) {
  if (isSituacaoAtiva(situacao)) return 3; // Máxima prioridade
  if (isSituacaoProvisoria(situacao)) return 2; // Média prioridade
  if (isSituacaoTerminal(situacao)) return 0; // Não bloqueia
  return 1; // Incerto/conservador
}

// Função principal: consultar marca no INPI (Infosimples)
async function consultarINPI(marca) {
  const token = process.env.INFOSIMPLES_TOKEN;
  
  if (!token) {
    throw new Error('Token Infosimples não configurado');
  }

  try {
    // SEMPRE E SÓ EXATA - POST request
    const response = await axios.post(
      'https://api.infosimples.com/api/v2/consultas/inpi/marcas',
      {
        marca: marca,
        tipo: 'exata', // SEMPRE EXATA
        token: token,
        timeout: 600
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    // Mapear erro 400 do INPI (marca não encontrada) para resposta limpa
    if (error.response && error.response.status === 400) {
      return {
        code: 200,
        code_message: 'Successful',
        processos: []
      };
    }
    throw error;
  }
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { marca } = req.body;

    // Validação de entrada
    if (!marca || typeof marca !== 'string' || marca.trim() === '') {
      return res.status(422).json({
        error: 'Parâmetro "marca" é obrigatório e deve ser uma string não vazia',
        disponivel: null
      });
    }

    const marcaNormalizada = marca.trim();
    const marcaSemAcentos = removerDiacriticos(marcaNormalizada);

    // ETAPA 1: PRÉ-VERIFICAÇÃO ALTO RENOME (antes de chamar API)
    const isAltoRenome = MARCAS_ALTO_RENOME.some(ar => {
      const arSemAcentos = removerDiacriticos(ar);
      return marcaSemAcentos === arSemAcentos || marcaSemAcentos.includes(arSemAcentos);
    });

    if (isAltoRenome) {
      return res.status(200).json({
        marca: marcaNormalizada,
        disponivel: false,
        motivo: 'Marca de Alto Renome protegida em todas as classes (Portaria INPI 181/2024)',
        processos: [],
        metadata: {
          fonte: 'Pre-verificacao Alto Renome',
          timestamp: new Date().toISOString()
        }
      });
    }

    // ETAPA 2: CONSULTA INPI (sempre tipo='exata')
    const resultado = await consultarINPI(marcaNormalizada);

    // ETAPA 3: ANÁLISE DE RESULTADOS
    const processos = resultado.processos || [];

    if (processos.length === 0) {
      // Nenhum processo encontrado = marca disponível
      return res.status(200).json({
        marca: marcaNormalizada,
        disponivel: true,
        motivo: 'Nenhum registro encontrado no INPI',
        processos: [],
        metadata: {
          fonte: 'INPI',
          timestamp: new Date().toISOString()
        }
      });
    }

    // ETAPA 4: FILTRAR MATCHES EXATOS (com normalização)
    const matchesExatos = processos.filter(proc => {
      const nomeProcSemAcentos = removerDiacriticos(proc.marca || '');
      return nomeProcSemAcentos === marcaSemAcentos;
    });

    if (matchesExatos.length === 0) {
      // Processos existem mas nenhum match exato = marca disponível
      return res.status(200).json({
        marca: marcaNormalizada,
        disponivel: true,
        motivo: 'Nenhum registro exato encontrado',
        processos: [],
        metadata: {
          fonte: 'INPI',
          timestamp: new Date().toISOString()
        }
      });
    }

    // ETAPA 5: CALCULAR PRIORIDADE MÁXIMA (hierarquia legal)
    let maxPrioridade = 0;
    let processoMaisForte = null;

    matchesExatos.forEach(proc => {
      const prioridade = calcularPrioridade(proc.situacao);
      if (prioridade > maxPrioridade) {
        maxPrioridade = prioridade;
        processoMaisForte = proc;
      }
    });

    // ETAPA 6: DECISÃO FINAL
     if (maxPrioridade >= 1) {
      // Situação ativa ou provisória = INDISPONÍVEL
      return res.status(200).json({
        marca: marcaNormalizada,
        disponivel: false,
        motivo: `Marca possui registro ${isSituacaoAtiva(processoMaisForte.situacao) ? 'ativo' : 'em andamento'} no INPI`,
        processos: matchesExatos.map(p => ({
          numero: p.numero,
          situacao: p.situacao,
          titular: p.titular,
          classe: p.classe
        })),
268
  metadata: {
          fonte: 'INPI',
          timestamp: new Date().toISOString()
        }
      });
    } else {
      // Situação terminal ou incerta (conservador) = tratado como disponível
      // (usuário pode verificar manualmente se necessário)
      return res.status(200).json({
        marca: marcaNormalizada,
        disponivel: true,
        motivo: 'Registros encontrados estão em situação terminal ou extinta',
        processos: matchesExatos.map(p => ({
          numero: p.numero,
          situacao: p.situacao,
          titular: p.titular,
          classe: p.classe
        })),
        metadata: {
          fonte: 'INPI',
          timestamp: new Date().toISOString(),
          aviso: 'Verifique manualmente os processos listados'
        }
      });
    }

  } catch (error) {
    console.error('Erro na consulta INPI:', error);
    
    // Erro de comunicação com INPI/Infosimples
    return res.status(502).json({
      error: 'Erro ao comunicar com o INPI',
      details: error.message,
      disponivel: null
    });
  }
}
