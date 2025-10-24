const axios = require('axios');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send("Método inválido");
  }
  const { marca } = req.body;
  const prompt = `
    Você é um advogado especialista em registros de marcas no Brasil.
    Consulte [https://branddb.wipo.int/pt/IPO-BR/similarname](https://branddb.wipo.int/pt/IPO-BR/similarname) se existe a marca exata "${marca}".
    Se existir, sugira três complementos viáveis para registro.
    Responda claramente para leigos.
  `;
  try {
    // NÃO coloque a chave! Use process.env.OPENAI_API_KEY
    const resposta = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.2
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    res.status(200).json({ resultado: resposta.data.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ resultado: 'Erro ao consultar IA.' });
  }
}
