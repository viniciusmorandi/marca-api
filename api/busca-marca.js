const axios = require('axios');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send("Método inválido");
  }

  const { marca } = req.body;

  try {
    // 1. CONSULTA REAL NO BANCO DA WIPO
    const consultaWIPO = await axios.get('https://branddb.wipo.int/pt/IPO-BR/similarname', {
      params: {
        brandName: marca,
        rows: 10
      }
    });

    // Verifica se encontrou resultados
    const resultadosEncontrados = consultaWIPO.data?.numFound > 0;
    const marcasExistentes = consultaWIPO.data?.results || [];

    // 2. MONTA O PROMPT COM OS DADOS REAIS
    let prompt = `
Você é um advogado especialista em registros de marcas no Brasil.

RESULTADO DA CONSULTA NA BASE WIPO/INPI para a marca "${marca}":
${resultadosEncontrados 
  ? `MARCA JÁ EXISTE! Encontradas ${marcasExistentes.length} marcas similares ou idênticas:\n${marcasExistentes.map(m => `- ${m.brandName} (Titular: ${m.holder})`).join('\n')}`
  : `MARCA DISPONÍVEL! Não foram encontradas marcas idênticas registradas.`
}

TAREFA:
${resultadosEncontrados
  ? `Como a marca já existe, sugira 3 (três) variações VIÁVEIS e CRIATIVAS do nome "${marca}" que possam ser registradas com sucesso. Explique cada sugestão de forma clara para leigos, destacando por que cada variação seria registrável.`
  : `A marca "${marca}" parece estar disponível! Explique de forma clara para leigos os próximos passos para realizar o registro no INPI.`
}

Responda de forma objetiva e profissional, mas acessível para quem não é da área jurídica.
`;

    // 3. ENVIA PARA A OPENAI COM OS DADOS REAIS
    const respostaIA = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        temperature: 0.3
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    // 4. RETORNA O RESULTADO
    res.status(200).json({
      consultaRealizada: true,
      marcaConsultada: marca,
      statusWIPO: resultadosEncontrados ? 'MARCA JÁ REGISTRADA' : 'MARCA DISPONÍVEL',
      totalEncontrados: marcasExistentes.length,
      analiseIA: respostaIA.data.choices[0].message.content
    });

  } catch (erro) {
    console.error('Erro:', erro.message);
    res.status(500).json({ 
      erro: 'Erro ao processar consulta',
      detalhes: erro.message 
    });
  }
}
