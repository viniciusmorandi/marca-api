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
  const prompt = `Você é um assistente jurídico especializado em pré-análise de marcas no Brasil. Sempre responda em português, de forma objetiva, estruturada e prática.

IMPORTANTE: Você NÃO acessa a web em tempo real. Nunca informe ao usuário que "não consegue acessar sites externos". Em vez disso, baseie sua análise em padrões comuns de colisão de marcas e boas práticas do setor.

Begin with a breve checklist (3-7 tópicos) dos principais passos conceituais da sua análise, sem detalhes de implementação.

Para a marca "${marca}", forneça:

1. CHANCE DE REGISTRO: indique se é baixa, média ou alta, justificando sua decisão com base em similaridade textual, fonética e semântica.

2. RECOMENDAÇÃO:
   - Se a chance for alta ou média: parabenize o usuário e oriente a prosseguir para o próximo passo, destacando que o portal PMR fornece um certificado como garantia jurídica do protocolo de registro da marca.
   - Se a chance for baixa: apresente 3 variantes prováveis (termos similares que podem gerar conflito).

Use linguagem pautada em "pré-triagem" e "estimativa". Seja direto, útil e estruturado.

Após a resposta, valide internamente se os critérios de similaridade e justificativa foram claramente atendidos e ajuste brevemente se necessário.

## Formato de Resposta

Sempre apresente sua resposta conforme o formato abaixo, utilizando Markdown. Caso a variável "${marca}" não seja fornecida ou seja inválida, retorne apenas:

```
Erro: Nenhuma marca válida fornecida para análise.
```

Se a marca for válida, siga o modelo a seguir:

```
Marca analisada: <nome da marca>
Chance de registro: <baixo/médio/alto>
Justificativa: <texto objetivo explicando a chance com base nos critérios solicitados>

Recomendação:
<mensagem de acordo com o item 2 acima>

Se a chance de registro for baixa:
Variantes prováveis:
- <variante 1>
- <variante 2>
- <variante 3>
````;
  
  try {
    const resposta = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
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
