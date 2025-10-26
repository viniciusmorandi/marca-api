import axios from 'axios';

// Função para normalizar texto (apenas lowercase e trim, SEM remover acentos)
function normalizar(texto) {
  if (!texto) return '';
  return texto.toLowerCase().trim();
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
    // Tentando usar tipo=exata (se não funcionar, usar tipo=radical)
    const formBody = `token=${encodeURIComponent(INFOSIMPLES_TOKEN)}&marca=${encodeURIComponent(marca)}&tipo=exata`;
    
    const response = await axios.post(infosimplesUrl, formBody, {
      timeout: 300000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    // Logar toda a resposta bruta do Infosimples para debug
    console.log('=== RESPOSTA COMPLETA DO INFOSIMPLES ===');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('=== FIM DA RESPOSTA ===');
    
    // Salvar resposta bruta em arquivo de log (em produção, considerar usar serviço de logging)
    console.log(`Teste para marca: "${marca}"`);
    
    // Verifica se a consulta foi bem-sucedida
    if (response.data && response.data.code === 200) {
      const processos = response.data.data?.processos || [];
      
      console.log(`Total de marcas encontradas: ${processos.length}`);
      
      // Função auxiliar para coletar textos dos processos
      const coletarTextos = (p) => [p?.marca, p?.denominacao, p?.titulo, p?.nome, p?.sinal].filter(Boolean);
      
      // Procura por correspondência exata APENAS EM MARCAS ATIVAS
      let marcaEncontrada = null;
      
      for (const proc of processos) {
        // Verifica se a marca está ativa
        const situacaoNorm = normalizar(proc?.situacao || '');
        const isAtiva = situacaoNorm.includes('ativo') || situacaoNorm.includes('registrada') || situacaoNorm.includes('registro');
        
        if (!isAtiva) {
          console.log(`Ignorando marca inativa: ${proc?.marca || 'N/A'} - Situação: ${proc?.situacao}`);
          continue; // Ignora marcas inativas
        }
        
        const candidatos = coletarTextos(proc);
        
        // Normalizar apenas lowercase e trim (SEM remover acentos)
        const candidatosNorm = candidatos.map(normalizar);
        
        console.log(`Comparando marca "${marcaNormalizada}" com candidatos:`, candidatosNorm);
        
        // Comparação exata: nome deve ser igual ao termo pesquisado (apenas lowercase/trim, preservando acentos)
        if (candidatosNorm.some(t => t === marcaNormalizada)) {
          marcaEncontrada = proc;
          console.log(`Match encontrado! Campo: ${candidatos[candidatosNorm.findIndex(t => t === marcaNormalizada)]}`);
          break;
        }
      }

      if (marcaEncontrada) {
        console.log('Marca ativa encontrada com correspondência exata!');
        return res.status(200).json({
          sucesso: true,
          disponivel: false,
          mensagem: `A marca "${marca}" já está registrada.`,
          dados_processuais: {
            numero: marcaEncontrada.numero || marcaEncontrada.processo || 'N/A',
            classe: marcaEncontrada.classe || marcaEncontrada.classe_nice || 'N/A',
            titular: marcaEncontrada.titular || marcaEncontrada.depositante || 'N/A',
            situacao: marcaEncontrada.situacao || 'N/A'
          }
        });
      }

      // Nenhuma marca ativa com correspondência exata encontrada
      console.log('Nenhuma marca ativa com correspondência exata encontrada');
      return res.status(200).json({
        sucesso: true,
        disponivel: true,
        mensagem: `A marca "${marca}" está disponível.`
      });
      
    } else {
      throw new Error(`Infosimples retornou erro: ${response.data?.code_message || 'Erro desconhecido'}`);
    }
    
  } catch (erro) {
    console.error('Erro ao buscar marca:', erro.message);
    console.error('Stack:', erro.stack);
    
    // Se erro 400 com tipo=exata, tentar novamente com tipo=radical
    if (erro.response?.status === 400 && erro.config?.data?.includes('tipo=exata')) {
      console.log('Parâmetro tipo=exata não suportado, tentando com tipo=radical...');
      
      try {
        const INFOSIMPLES_TOKEN = process.env.INFOSIMPLES_TOKEN || '$EU_TOKEN_AQUI';
        const infosimplesUrl = 'https://api.infosimples.com/api/v2/consultas/inpi/marcas';
        const formBody = `token=${encodeURIComponent(INFOSIMPLES_TOKEN)}&marca=${encodeURIComponent(req.body.marca)}&tipo=radical`;
        
        const response = await axios.post(infosimplesUrl, formBody, {
          timeout: 300000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });
        
        // Logar toda a resposta bruta
        console.log('=== RESPOSTA COMPLETA DO INFOSIMPLES (tipo=radical) ===');
        console.log(JSON.stringify(response.data, null, 2));
        console.log('=== FIM DA RESPOSTA ===');
        
        if (response.data && response.data.code === 200) {
          const processos = response.data.data?.processos || [];
          const marcaNormalizada = normalizar(req.body.marca);
          
          console.log(`Total de marcas encontradas (radical): ${processos.length}`);
          
          const coletarTextos = (p) => [p?.marca, p?.denominacao, p?.titulo, p?.nome, p?.sinal].filter(Boolean);
          let marcaEncontrada = null;
          
          for (const proc of processos) {
            const situacaoNorm = normalizar(proc?.situacao || '');
            const isAtiva = situacaoNorm.includes('ativo') || situacaoNorm.includes('registrada') || situacaoNorm.includes('registro');
            
            if (!isAtiva) {
              console.log(`Ignorando marca inativa: ${proc?.marca || 'N/A'} - Situação: ${proc?.situacao}`);
              continue;
            }
            
            const candidatos = coletarTextos(proc);
            const candidatosNorm = candidatos.map(normalizar);
            
            console.log(`Comparando marca "${marcaNormalizada}" com candidatos:`, candidatosNorm);
            
            if (candidatosNorm.some(t => t === marcaNormalizada)) {
              marcaEncontrada = proc;
              console.log(`Match encontrado! Campo: ${candidatos[candidatosNorm.findIndex(t => t === marcaNormalizada)]}`);
              break;
            }
          }
          
          if (marcaEncontrada) {
            console.log('Marca ativa encontrada com correspondência exata!');
            return res.status(200).json({
              sucesso: true,
              disponivel: false,
              mensagem: `A marca "${req.body.marca}" já está registrada.`,
              dados_processuais: {
                numero: marcaEncontrada.numero || marcaEncontrada.processo || 'N/A',
                classe: marcaEncontrada.classe || marcaEncontrada.classe_nice || 'N/A',
                titular: marcaEncontrada.titular || marcaEncontrada.depositante || 'N/A',
                situacao: marcaEncontrada.situacao || 'N/A'
              }
            });
          }
          
          console.log('Nenhuma marca ativa com correspondência exata encontrada');
          return res.status(200).json({
            sucesso: true,
            disponivel: true,
            mensagem: `A marca "${req.body.marca}" está disponível.`
          });
        }
      } catch (err2) {
        console.error('Erro também com tipo=radical:', err2.message);
        // Continua para o tratamento de erro padrão abaixo
      }
    }
    
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
