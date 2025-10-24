export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send("Método inválido");
  }
  const { marca } = req.body;
  const prompt = `
    Você é um advogado especialista em registros de marcas no Brasil.
    Consulte https://branddb.wipo.int/pt/IPO-BR/similarname se existe a marca exata "${marca}".
    Se existir, sugira três complementos viáveis para registro.
    Responda claramente para leigos.
  `;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.2
      })
    });
    const data = await response.json();
    res.status(200).json({ resultado: data.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ resultado: 'Erro ao consultar IA.' });
  }
}
