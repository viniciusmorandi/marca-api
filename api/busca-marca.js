import axios from 'axios';

// Função para normalizar texto (remove acentos e coloca em minúsculas)
function normalizar(texto) {
  if (!texto) return '';
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export default async function handler(req, res) {
  // Adicionar headers CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Responde ao preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).end('Método inválido');
  }

  const { marca } = req.body;

  if (!marca || marca.trim() === '') {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Nome da marca é obrigatório'
    });
  }

  try {
    console.log(`Buscando marca: ${marca}`);

    const marcaNormalizada = normalizar(marca);

    // Chave de API do Infosimples
    const INFOSIMPLES_TOKEN = process.env.INFOSIMPLES_TOKEN || '$EU_TOKEN_AQUI';

    // URL da API do Infosimples para INPI Marcas
    const infosimplesUrl = 'https://api.infosimples.com/api/v2/consultas/inpi/marcas';
    console.log('Chamando API do Infosimples...');

    // Prepara os dados como form data string
    const formBody = `token=${encodeURIComponent(INFOSIMPLES_TOKEN)}&marca=${encodeURIComponent(marcaNormalizada)}&tipo=exata`;

    console.log('Enviando form data:', formBody.substring(0, 50) + '...');

    const response = await axios.post(infosimplesUrl, formBody, {
      timeout: 300000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    console.log('Resposta do Infosimples:', JSON.stringify(response.data).substring(0, 200));

    // Verifica se a consulta foi bem-sucedida
    if (response.data && response.data.code === 200) {
      const processos = response.data.data?.processos || [];
      const totalEncontrado = response.data.data?.processos_total || 0;

      console.log(`Total de marcas encontradas: ${totalEncontrado}`);

      // Função auxiliar para coletar textos dos processos
      const coletarTextos = (p) => [p?.marca, p?.denominacao, p?.titulo, p?.nome, p?.sinal].filter(Boolean);

      // Procura por correspondência exata
      let correspondenciaExata = null;

      for (const proc of processos) {
        const candidatos = coletarTextos(proc);
        const candidatosNorm = candidatos.map(normalizar);
        console.log('Candidatos comparados:', candidatosNorm.slice(0,3));
        if (candidatosNorm.some(t => t === marcaNormalizada)) {
          correspondenciaExata = proc;
          break;
        }
      }

      if (correspondenciaExata) {
        console.log('Correspondência EXATA encontrada!');
        return res.status(200).json({
          sucesso: true,
          disponivel: false,
          probabilidade: 'BAIXA_PROBABILIDADE',
          mensagem: `\u26a0 Ops! A marca "${marca}" já está registrada no INPI (Brasil).`,
          detalhes: { fonte: 'INPI via Infosimples' }
        });
      }

      // Fallback: verifica similaridade por tokens
      const tokensEntrada = new Set(marcaNormalizada.split(' '));
      const similar = processos.some(p => {
        const cand = coletarTextos(p).map(normalizar).join(' ');
        const tokens = cand.split(' ');
        let inter = 0;
        for (const t of tokens) if (tokensEntrada.has(t)) inter++;
        return inter >= 2 && cand.length > 0;
      });

      if (similar) {
        console.log('Similaridade forte detectada');
        return res.status(200).json({
          sucesso: true,
          disponivel: false,
          probabilidade: 'ALTA_PROBABILIDADE',
          mensagem: `\u26a0 Atenção! A marca "${marca}" tem alta chance de conflito no INPI.`,
          detalhes: { fonte: 'INPI via Infosimples' }
        });
      }

      console.log('Nenhuma marca similar encontrada');
      return res.status(200).json({
        sucesso: true,
        disponivel: true,
        probabilidade: 'ALTA_PROBABILIDADE',
        mensagem: `\u2705 Boa notícia! A marca "${marca}" aparenta estar disponível para registro.`,
        detalhes: { fonte: 'INPI via Infosimples' }
      });

    } else {
      throw new Error(`Infosimples retornou erro: ${response.data?.code_message || 'Erro desconhecido'}`);
    }

  } catch (erro) {
    console.error('Erro ao buscar marca:', erro.message);
    console.error('Stack:', erro.stack);

    if (erro.response?.status === 401) {
      return res.status(500).json({
        sucesso: false,
        mensagem: 'Token do Infosimples inválido ou não configurado. Configure a variável INFOSIMPLES_TOKEN no Vercel.',
        erro: 'Authentication error'
      });
    }

    return res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao consultar base de dados de marcas. Tente novamente.',
      erro: erro.message
    });
  }
}
