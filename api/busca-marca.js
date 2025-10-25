import axios from 'axios';

// Função para normalizar texto (remove acentos e coloca em minúsculas)
function normalizar(texto) {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export default async function handler(req, res) {
  // Adiciona headers CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Responde ao preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Método inválido');
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

    // Faz requisição ao backend interno da WIPO que retorna JSON
    // Este endpoint é usado pela interface web do WIPO
    const wipoUrl = 'https://branddb.wipo.int/api/v1/brand';
    
    const searchParams = {
      rows: 100, // Buscar primeiros 100 resultados
      start: 0,
      sort: 'score desc',
      fg: '_void_',
      asStructure: JSON.stringify({
        boolean: 'AND',
        bricks: [
          {
            key: 'brandName',
            value: marca,
            strategy: 'Simple'
          },
          {
            key: 'office',
            value: 'BR', // Filtra apenas Brasil
            strategy: 'Simple'
          }
        ]
      })
    };

    console.log('Chamando API da WIPO...');
    
    const response = await axios.get(wipoUrl, {
      params: searchParams,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 15000
    });

    console.log(`WIPO retornou ${response.data?.response?.numFound || 0} resultados`);

    // Se a API retornar dados, processa
    if (response.data && response.data.response) {
      const resultados = response.data.response.docs || [];
      const totalEncontrado = response.data.response.numFound || 0;

      console.log(`Total de marcas encontradas: ${totalEncontrado}`);

      // Procura por correspondência exata (nome normalizado)
      const correspondenciaExata = resultados.find(item => {
        const nomeMarca = item.brandName || item.name || '';
        const nomeMarcaNormalizado = normalizar(nomeMarca);
        return nomeMarcaNormalizado === marcaNormalizada;
      });

      if (correspondenciaExata) {
        console.log('Correspondência EXATA encontrada!');
        return res.status(200).json({
          sucesso: true,
          disponivel: false,
          probabilidade: 'BAIXA_PROBABILIDADE',
          mensagem: `A marca "${marca}" já está registrada no INPI (Brasil).`,
          detalhes: {
            marcaEncontrada: correspondenciaExata.brandName || correspondenciaExata.name,
            numeroRegistro: correspondenciaExata.applicationNumber,
            situacao: correspondenciaExata.status,
            fonte: 'WIPO/INPI'
          }
        });
      } else if (totalEncontrado > 0) {
        // Encontrou marcas similares, mas não exata
        console.log('Marcas similares encontradas, mas não correspondência exata');
        return res.status(200).json({
          sucesso: true,
          disponivel: true,
          probabilidade: 'MEDIA_PROBABILIDADE',
          mensagem: `Não encontramos registro exato de "${marca}", mas existem ${totalEncontrado} marcas similares. Recomendamos análise detalhada.`,
          detalhes: {
            marcasSimilares: totalEncontrado,
            fonte: 'WIPO/INPI'
          }
        });
      } else {
        // Nenhum resultado encontrado
        console.log('Nenhuma marca similar encontrada');
        return res.status(200).json({
          sucesso: true,
          disponivel: true,
          probabilidade: 'ALTA_PROBABILIDADE',
          mensagem: `A marca "${marca}" aparenta estar disponível para registro.`,
          detalhes: {
            fonte: 'WIPO/INPI'
          }
        });
      }
    } else {
      throw new Error('Formato de resposta inesperado da API');
    }

  } catch (erro) {
    console.error('Erro ao buscar marca:', erro.message);
    console.error('Stack:', erro.stack);
    
    return res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao consultar base de dados de marcas. Tente novamente.',
      erro: erro.message
    });
  }
}
