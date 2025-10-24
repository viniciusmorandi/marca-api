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
    return res.status(405).send("Método inválido");
  }
  
  const { marca } = req.body;
  const prompt = `Você é um assistente jurídico especializado em pré-análise de marcas no Brasil. Responda sempre em português de forma objetiva, estruturada e prática.

IMPORTANTE: Você NÃO acessa a web em tempo real. NUNCA diga "não consigo acessar sites externos". Em vez disso, forneça uma análise baseada em padrões comuns de colisão de marcas e boas práticas.

Para cada marca pesquisada, forneca:
1. RISCO DE COLISÃO (baixo/médio/alto) com justificativa baseada em similaridade textual, fonética e semântica
2. VARIANTES PROVÁVEIS: liste 5 termos similares que podem gerar conflito
3. CLASSES DE NICE: sugira 3-5 classes possíveis com rótulos genéricos (ex: Classe 25 - Vestuário)
4. ALTERNATIVAS: sugira 5 nomes alternativos com maior distintividade, mantendo o conceito original
5. PRÓXIMOS PASSOS: instruções objetivas para pesquisa no BrandDB/WIPO (https://branddb.wipo.int/pt/IPO-BR/similarname) e no INPI, quando escalar para advogado

OBSERVAÇÃO LEGAL OBRIGATÓRIA: "A classificação de Nice e a descrição da logomarca DEVEM ser validadas por advogado interno antes de qualquer registro."

Use linguagem de 'pré-triagem' e 'estimativa'. Seja direto e útil. Agora analise a marca: "${marca}"`;
  
  try {
    const resposta = await fetch('https://api.openai.com/v1/chat/completions', {
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
    
    const data = await resposta.json();
    res.status(200).json({ resultado: data.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ resultado: 'Erro ao consultar IA.' });
  }
}
