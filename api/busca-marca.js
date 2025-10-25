import axios from 'axios';
import * as cheerio from 'cheerio';

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

  try {
    // 1. CONSULTA REAL NO BANCO DA WIPO - Busca HTML
    const urlWIPO = `https://branddb.wipo.int/pt/IPO-BR/similarname?word=${encodeURIComponent(marca)}&rows=50`;
    
    const consultaWIPO = await axios.get(urlWIPO, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 15000
    });

    // 2. PARSE DO HTML COM CHEERIO
    const $ = cheerio.load(consultaWIPO.data);
    
    // Array para armazenar as marcas encontradas
    const marcasEncontradas = [];
    
    // Busca por elementos que contêm informações de marcas
    // A estrutura pode variar, então vamos tentar diferentes seletores
    $('.brand-item, .trademark-item, .result-item, tr.brand-row').each((i, elem) => {
      const $elem = $(elem);
      
      // Tenta extrair informações da marca
      const nomeMarca = $elem.find('.brand-name, .trademark-name, .name, td.name').text().trim() ||
                        $elem.find('td').eq(0).text().trim();
      
      const titular = $elem.find('.holder, .owner, .titular, td.holder').text().trim() ||
                     $elem.find('td').eq(1).text().trim();
      
      const status = $elem.find('.status, td.status').text().trim() ||
                    $elem.find('td').eq(2).text().trim();
      
      const numero = $elem.find('.number, .registration-number, td.number').text().trim() ||
                    $elem.find('td').eq(3).text().trim();
      
      // Se encontrou pelo menos o nome da marca, adiciona ao array
      if (nomeMarca && nomeMarca.length > 0) {
        marcasEncontradas.push({
          nome: nomeMarca,
          titular: titular || 'Não informado',
          status: status || 'Não informado',
          numero: numero || 'Não informado'
        });
      }
    });
    
    // Se não encontrou com os seletores acima, tenta uma abordagem mais genérica
    if (marcasEncontradas.length === 0) {
      $('table tr').each((i, row) => {
        if (i === 0) return; // Pula o cabeçalho
        
        const $row = $(row);
        const cells = $row.find('td');
        
        if (cells.length >= 2) {
          const nomeMarca = $(cells[0]).text().trim();
          const titular = $(cells[1]).text().trim();
          const status = cells.length > 2 ? $(cells[2]).text().trim() : 'Não informado';
          const numero = cells.length > 3 ? $(cells[3]).text().trim() : 'Não informado';
          
          if (nomeMarca && nomeMarca.length > 2) {
            marcasEncontradas.push({
              nome: nomeMarca,
              titular,
              status,
              numero
            });
          }
        }
      });
    }
    
    // 3. BUSCA NOMINATIVA EXATA
    const marcaNormalizada = normalizar(marca);
    
    // Filtra apenas marcas registradas no Brasil e compara normalizado
    const marcasExatasNoBrasil = marcasEncontradas.filter(m => {
      const nomeNormalizado = normalizar(m.nome);
      
      // Verifica se é exatamente igual (após normalização)
      const isExataMatch = nomeNormalizado === marcaNormalizada;
      
      // Verifica se é do Brasil (pode aparecer como "Brazil", "Brasil", "BR", etc.)
      const isBrasil = m.titular.toLowerCase().includes('bras') || 
                      m.titular.toLowerCase().includes('brazil') ||
                      m.numero.includes('BR');
      
      return isExataMatch && isBrasil;
    });
    
    // 4. CLASSIFICAÇÃO DE PROBABILIDADE
    const temMarcaExata = marcasExatasNoBrasil.length > 0;
    const probabilidade = temMarcaExata ? 'BAIXA_PROBABILIDADE' : 'ALTA_PROBABILIDADE';
    
    // 5. MONTA O PROMPT COM OS DADOS REAIS
    let prompt = `Você é um advogado especialista em registros de marcas no Brasil.

RESULTADO DA CONSULTA NA BASE WIPO/INPI para a marca "${marca}":

`;
    
    if (temMarcaExata) {
      prompt += `⚠️ MARCA JÁ EXISTE! Encontradas ${marcasExatasNoBrasil.length} marca(s) com nome nominativo EXATO no Brasil:\n\n`;
      marcasExatasNoBrasil.forEach((m, idx) => {
        prompt += `${idx + 1}. Nome: ${m.nome}\n   Titular: ${m.titular}\n   Status: ${m.status}\n   Número: ${m.numero}\n\n`;
      });
      prompt += `\nClassificação: BAIXA PROBABILIDADE de sucesso no registro.\n\n`;
      prompt += `Análise: Como foram encontrados registros com o nome nominativo EXATO "${marca}" no INPI/Brasil, isso indica BAIXA PROBABILIDADE de sucesso para um novo registro com o mesmo nome.`;
    } else {
      prompt += `✅ MARCA DISPONÍVEL! Não foram encontradas marcas com nome nominativo EXATO "${marca}" no Brasil.\n\n`;
      
      if (marcasEncontradas.length > 0) {
        prompt += `Foram encontradas ${marcasEncontradas.length} marca(s) similares (mas não exatamente iguais):\n\n`;
        marcasEncontradas.slice(0, 5).forEach((m, idx) => {
          prompt += `${idx + 1}. ${m.nome} - ${m.titular}\n`;
        });
        prompt += `\n`;
      }
      
      prompt += `Classificação: ALTA PROBABILIDADE de sucesso no registro.\n\n`;
      prompt += `Análise: Como NÃO foram encontrados registros com o nome nominativo EXATO "${marca}" no INPI/Brasil, isso indica ALTA PROBABILIDADE de sucesso para o registro.`;
    }
    
    // 6. CONSULTA A OPENAI
    const respostaOpenAI = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'Você é um advogado especialista em propriedade intelectual e registro de marcas no Brasil. Analise os dados fornecidos e forneça uma resposta profissional, clara e objetiva.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const analiseIA = respostaOpenAI.data.choices[0].message.content;

    // 7. RETORNA RESULTADO ESTRUTURADO
    return res.status(200).json({
      sucesso: true,
      marca: marca,
      probabilidade: probabilidade,
      marcasExatasEncontradas: marcasExatasNoBrasil,
      totalMarcasSimilares: marcasEncontradas.length,
      analiseIA: analiseIA,
      // Para compatibilidade com o código Wix antigo
      resultado: analiseIA
    });

  } catch (erro) {
    console.error('Erro detalhado:', erro.message);
    console.error('Stack:', erro.stack);
    
    return res.status(500).json({
      sucesso: false,
      erro: 'Erro ao consultar base de dados de marcas',
      detalhes: erro.message
    });
  }
}
