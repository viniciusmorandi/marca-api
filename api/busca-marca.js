114
  import axios from 'axios';

// Função para normalizar texto (apenas lowercase e trim, SEM remover acentos)
function normalizar(texto) {
  if (!texto) return '';
  return texto.toLowerCase().trim();
}

// Verifica se situação é considerada ativa/vigente
// Verifica se situação é considerada ativa/vigente (BLOQUEIA novo registro)
function isSituacaoAtiva(situacao) {
  const s = normalizar(situacao || '');
  
  // Statuses que BLOQUEIAM registro (indicam marca ativa)
  const bloqueaRegistro = [
    'concedida', 'concessao',
    'registrada', 'registro',
    'ativa', 'vigente', 'vigencia',
    'deferida',
    'publicada'
        'alto renome',
  ];
  
  // Statuses que PERMITEM registro (não mais válidos)
  const permiteRegistro = [
    'arquivada', 'arquivamento',
    'extinta',
    'indeferida', 'negada', 'negado',
    'caducada', 'caducado',
    'cancelada', 'cancelado'
  ];
  
  // Verifica se status indica BLOQUEIO
  const isBlocking = bloqueaRegistro.some(term => s.includes(term));
  
  // Se claramente bloqueia, retorna true
  if (isBlocking) return true;
  
  // Se claramente permite, retorna false
  const isAllowing = permiteRegistro.some(term => s.includes(term));
  if (isAllowing) return false;
  
  // Para valores indeterminados (em andamento, em exame, etc), ser conservador
  // Tratar como bloqueio para evitar permitir registro em processos ativos
  return true;
}

// Coleta campos de texto relevantes do processo
function coletarTextos(proc) {
  return [
    proc?.marca,
    proc?.denominacao,
    proc?.titulo,
    proc?.nome,
    proc?.sinal,
    proc?.apresentacao,
    proc?.niza_class || proc?.classe || proc?.classe_nice,
    proc?.titular,
    proc?.depositante,
  ].filter(Boolean);
}

// Log detalhado de um processo (todos os campos)
function logProcessoCompleto(proc, idx) {
  try {
    console.log(`--- Processo [${idx}] Campos completos ---`);
    // Logar o objeto completo
    console.log(JSON.stringify(proc, null, 2));
    // Além disso, logar campos normalizados relevantes para comparação
    const textos = coletarTextos(proc);
    console.log('Campos relevantes:', textos);
    console.log('Campos relevantes normalizados:', textos.map(normalizar));
  } catch (e) {
    console.log('Falha ao logar processo completo:', e?.message);
  }
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
      const processos = response.data[0]?.processos || [];
      
      console.log(`Total de marcas encontradas: ${processos.length}`);
      
      // Log de todos os processos com campos completos
      processos.forEach((p, i) => logProcessoCompleto(p, i));

      // Procura por correspondência exata EM MARCAS ATIVAS/VIGENTES
      let marcaEncontrada = null;
        let marcaAtiva = false;
      
      for (const proc of processos) {
        const situacao = proc?.situacao || proc?.status || proc?.situacao_atual;
        const ativa = isSituacaoAtiva(situacao);
        const candidatos = coletarTextos(proc);
        const candidatosNorm = candidatos.map(normalizar);
        console.log(`Comparando marca "${marcaNormalizada}" com candidatos:`, candidatosNorm);
        // Comparação avançada: substring (marcaNormalizada contida em qualquer candidato)
    if (candidatosNorm.some(t => t === marcaNormalizada)) {          marcaEncontrada = proc;
                                                                 marcaAtiva = ativa;
          console.log(`correspondência exata encontrado! Campo: ${candidatos[candidatosNorm.findIndex(t => t.includes(marcaNormalizada))]}`);
        }
      }
      if (marcaEncontrada && marcaAtiva) {
    console.log('Marca ativa/vigente encontrada com correspondência exata!');        return res.status(200).json({
          sucesso: true,
          disponivel: false,
          mensagem: `A marca "${marca}" já está registrada (correspondência exata).`,
          dados_processuais: {
            numero: marcaEncontrada.numero || marcaEncontrada.processo || 'N/A',
            classe: marcaEncontrada.classe || marcaEncontrada.classe_nice || 'N/A',
            titular: marcaEncontrada.titular || marcaEncontrada.depositante || 'N/A',
            situacao: marcaEncontrada.situacao || marcaEncontrada.status || 'N/A'
          }
        });
      }
      // Nenhuma marca ativa com correspondência exata encontrada
    console.log('Nenhuma marca ativa/vigente com correspondência exata              encontrada');
      // Se a marca é famosa e ainda assim nada veio, adicionar alerta para consulta manual
      const alerta = processos.length === 0 ?
        'Nenhum resultado retornado pela API. Verifique manualmente no e-INPI.' :
        undefined;

      return res.status(200).json({
        sucesso: true,
        disponivel: true,
        mensagem: `A marca "${marca}" aparenta estar disponível (sem matches ativos).`,
        alerta
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
          const processos = response.data[0]?.processos || [];
          const marcaNormalizada = normalizar(req.body.marca);
          
          console.log(`Total de marcas encontradas (radical): ${processos.length}`);
          processos.forEach((p, i) => logProcessoCompleto(p, i));
          
          let marcaEncontrada = null;
          
          for (const proc of processos) {
            const situacao = proc?.situacao || proc?.status || proc?.situacao_atual;
            const ativa = isSituacaoAtiva(situacao);
            if (!ativa) {
              console.log(`Ignorando marca não ativa/vigente: ${proc?.marca || 'N/A'} - Situação: ${situacao}`);
              continue;
            }
            const candidatos = coletarTextos(proc);
            const candidatosNorm = candidatos.map(normalizar);
            console.log(`Comparando marca "${marcaNormalizada}" com candidatos:`, candidatosNorm);
            if (candidatosNorm.some(t => t.includes(marcaNormalizada))) {
              marcaEncontrada = proc;
              console.log(`correspondência exata encontrado! Campo: ${candidatos[candidatosNorm.findIndex(t => t.includes(marcaNormalizada))]}`);
              break;
            }
          }
          
          if (marcaEncontrada) {
            console.log('Marca ativa/vigente encontrada com correspondência exata!');
            return res.status(200).json({
              sucesso: true,
              disponivel: false,
              mensagem: `A marca "${req.body.marca}" já está registrada (134
              ).`,
              dados_processuais: {
                numero: marcaEncontrada.numero || 115
                  .processo || 'N/A',
                classe: marcaEncontrada.classe || marcaEncontrada.classe_nice || 'N/A',
                titular: marcaEncontrada.titular || marcaEncontrada.depositante || 'N/A',
                situacao: marcaEncontrada.situacao || marcaEncontrada.status || 'N/A'
              }
            });
          }
          
          console.log('Nenhuma marca ativa/vigente com correspondência exata encontrada');
          const alerta = processos.length === 0 ? 'Nenhum resultado retornado pela API. Verifique manualmente no e-INPI.' : undefined;
          return res.status(200).json({
            sucesso: true,
            disponivel: true,
            mensagem: `A marca "${req.body.marca}" aparenta estar disponível (sem matches ativos).`,
            alerta
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
