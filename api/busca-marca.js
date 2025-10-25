import axios from 'axios';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

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
  let browser = null;

  try {
    // 1. INICIA O PUPPETEER para carregar JavaScript
    console.log('Iniciando Puppeteer...');
    
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // 2. NAVEGA PARA A URL DE BUSCA DA WIPO
    const urlWIPO = `https://branddb.wipo.int/pt/IPO-BR/similarname?sort=score%20desc&start=0&rows=50`;
    console.log('Navegando para WIPO:', urlWIPO);
    
    await page.goto(urlWIPO, { waitUntil: 'networkidle0', timeout: 30000 });
    
    // 3. PREENCHE O CAMPO DE BUSCA E SUBMETE
    console.log('Preenchendo busca por:', marca);
    
    // Aguarda o campo de busca aparecer
    await page.waitForSelector('input[placeholder*="Brand name"], input[placeholder*="Nome de marca"], input[type="text"]', { timeout: 10000 });
    
    // Digita o nome da marca
    await page.type('input[type="text"]', marca);
    
    // Pressiona Enter ou clica no botão de busca
    await page.keyboard.press('Enter');
    
    // Aguarda os resultados carregarem
    console.log('Aguardando resultados...');
    await page.waitForTimeout(5000); // Espera 5 segundos para carregar
    
    // 4. EXTRAI O TEXTO DA PÁGINA
    const conteudoPagina = await page.evaluate(() => document.body.innerText);
    
    console.log('Conteúdo extraído (primeiros 500 chars):', conteudoPagina.substring(0, 500));
    
    // 5. PARSE MANUAL DO TEXTO EXTRAÍDO
    const marcasEncontradas = [];
    const marcaNormalizada = normalizar(marca);
    
    // Procura por padrões no texto
    const linhas = conteudoPagina.split('\n');
    let marcaAtual = {};
    
    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i].trim();
      
      // Detecta início de um novo registro de marca
      if (linha && !linha.includes('Exibindo') && !linha.includes('Filtros') && linha.length > 2 && linha.length < 100) {
        // Se parece ser um nome de marca (linha curta, não é label)
        if (!linha.includes(':') && !linha.includes('Titular') && !linha.includes('Classe') && !linha.includes('IPR') && !linha.includes('País') && !linha.includes('Situação') && !linha.includes('Número')) {
          // Se já temos uma marca em construção, salva ela
          if (marcaAtual.nome) {
            marcasEncontradas.push({...marcaAtual});
          }
          // Inicia nova marca
          marcaAtual = { nome: linha };
        }
      }
      
      // Extrai informações da marca atual
      if (linha.includes('Titular') && i + 1 < linhas.length) {
        marcaAtual.titular = linhas[i + 1].trim();
      }
      if (linha.includes('Situação') && i + 1 < linhas.length) {
        marcaAtual.status = linhas[i + 1].trim();
      }
      if (linha.includes('Número') && i + 1 < linhas.length) {
        marcaAtual.numero = linhas[i + 1].trim();
      }
      if (linha.includes('País de depósito') && i + 1 < linhas.length) {
        marcaAtual.pais = linhas[i + 1].trim();
      }
    }
    
    // Adiciona a última marca se existir
    if (marcaAtual.nome) {
      marcasEncontradas.push(marcaAtual);
    }
    
    console.log('Marcas encontradas:', marcasEncontradas.length);
    
    // 6. BUSCA NOMINATIVA EXATA
    // Filtra apenas marcas do Brasil com nome exato
    const marcasExatasNoBrasil = marcasEncontradas.filter(m => {
      const nomeNormalizado = normalizar(m.nome || '');
      const isExataMatch = nomeNormalizado === marcaNormalizada;
      const isBrasil = (m.pais && m.pais.toLowerCase().includes('bras')) || 
                      (m.titular && m.titular.toLowerCase().includes('brasil'));
      
      console.log(`Comparando: "${nomeNormalizado}" === "${marcaNormalizada}" ? ${isExataMatch}, Brasil? ${isBrasil}`);
      
      return isExataMatch && isBrasil;
    });
    
    console.log('Marcas exatas no Brasil:', marcasExatasNoBrasil.length);
    
    // 7. CLASSIFICAÇÃO DE PROBABILIDADE
    const temMarcaExata = marcasExatasNoBrasil.length > 0;
    const probabilidade = temMarcaExata ? 'BAIXA_PROBABILIDADE' : 'ALTA_PROBABILIDADE';
    
    // 8. MONTA O PROMPT COM OS DADOS REAIS
    let prompt = `Você é um advogado especialista em registros de marcas no Brasil.\n\nRESULTADO DA CONSULTA NA BASE WIPO/INPI para a marca "${marca}":\n\n`;
    
    if (temMarcaExata) {
      prompt += `⚠️ MARCA JÁ EXISTE! Encontradas ${marcasExatasNoBrasil.length} marca(s) com nome nominativo EXATO no Brasil:\n\n`;
      marcasExatasNoBrasil.forEach((m, idx) => {
        prompt += `${idx + 1}. Nome: ${m.nome}\n   Titular: ${m.titular || 'Não informado'}\n   Status: ${m.status || 'Não informado'}\n   Número: ${m.numero || 'Não informado'}\n\n`;
      });
      prompt += `\nClassificação: BAIXA PROBABILIDADE de sucesso no registro.\n\n`;
      prompt += `Análise: Como foram encontrados registros com o nome nominativo EXATO "${marca}" no INPI/Brasil, isso indica BAIXA PROBABILIDADE de sucesso para um novo registro com o mesmo nome. Recomenda-se buscar um nome alternativo ou consultar um advogado especializado em propriedade intelectual.`;
    } else {
      prompt += `✅ MARCA DISPONÍVEL! Não foram encontradas marcas com nome nominativo EXATO "${marca}" no Brasil.\n\n`;
      
      if (marcasEncontradas.length > 0) {
        prompt += `Foram encontradas ${marcasEncontradas.length} marca(s) similares (mas não exatamente iguais):\n\n`;
        marcasEncontradas.slice(0, 5).forEach((m, idx) => {
          prompt += `${idx + 1}. ${m.nome} - ${m.titular || 'Não informado'}\n`;
        });
        prompt += `\n`;
      }
      
      prompt += `Classificação: ALTA PROBABILIDADE de sucesso no registro.\n\n`;
      prompt += `Análise: Como NÃO foram encontrados registros com o nome nominativo EXATO "${marca}" no INPI/Brasil, isso indica ALTA PROBABILIDADE de sucesso para o registro. Ainda assim, recomenda-se prosseguir com o pedido de registro o quanto antes para garantir a prioridade.`;
    }
    
    console.log('Prompt para OpenAI:', prompt.substring(0, 300));
    
    // 9. CONSULTA A OPENAI
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
    
    console.log('Resposta OpenAI recebida');

    // 10. RETORNA RESULTADO ESTRUTURADO
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
  } finally {
    // Fecha o browser
    if (browser) {
      await browser.close();
    }
  }
}
