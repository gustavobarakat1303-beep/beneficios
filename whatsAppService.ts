
/**
 * CONFIGURAÇÃO DE INTEGRAÇÃO - WHATSAPP (VIA BRIDGE PHP)
 * Servidor: srv6.crmstation.net
 * Instância: 1912_nomade
 */
const WA_CONFIG = {
  BRIDGE_URL: 'https://srv6.crmstation.net/api/api_automatize.php',
  INSTANCE: '1912_nomade', 
  API_KEY: '94605',
};

const otpStore = new Map<string, { code: string, expires: number }>();

export const whatsAppService = {
  /**
   * Verifica o status da bridge.
   * Em modo no-cors, o fetch não permite ler o conteúdo da resposta,
   * mas serve como um 'ping' para validar se o servidor está online e aceita a requisição.
   */
  checkStatus: async (): Promise<{ success: boolean; state?: string; message?: string }> => {
    try {
      const query = new URLSearchParams({
        action: 'status',
        instance: WA_CONFIG.INSTANCE,
        apikey: WA_CONFIG.API_KEY
      }).toString();
      
      const url = `${WA_CONFIG.BRIDGE_URL}?${query}`;
      await fetch(url, { mode: 'no-cors', cache: 'no-cache' });
      
      return { 
        success: true, 
        state: 'online',
        message: `Instância ${WA_CONFIG.INSTANCE} alcançada em srv6.`
      };
    } catch (error) {
      console.warn('[VoucherHub] Erro de conectividade:', error);
      return { success: false, message: 'Servidor da bridge inacessível.' };
    }
  },

  /**
   * Envia o código OTP via Bridge PHP.
   * Utiliza GET para evitar problemas de preflight CORS (OPTIONS) que ocorrem frequentemente em bridges PHP.
   */
  sendOTP: async (phone: string, cpf: string): Promise<boolean> => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Limpeza absoluta do número: apenas dígitos
    let cleanNumber = phone.replace(/\D/g, '');
    
    // Formatação: garante prefixo 55 (Brasil) para números de 10 ou 11 dígitos
    if (cleanNumber.length === 10 || cleanNumber.length === 11) {
      cleanNumber = '55' + cleanNumber;
    }

    // Armazena localmente para validação (contingência se o SMS atrasar)
    otpStore.set(phone, { code, expires: Date.now() + (5 * 60 * 1000) });

    const messageText = `*VoucherHub*\n\nSeu código de acesso é: *${code}*\n\nUtilize-o para resgatar seu benefício.`;

    // LOG DE SEGURANÇA NO CONSOLE (F12) - Útil para debugar se o servidor recebeu
    console.log("%c==========================================", "color: #25D366; font-weight: bold;");
    console.log(`%c[WHATSAPP] DISPARO PARA: ${cleanNumber}`, "color: #25D366; font-weight: bold;");
    console.log(`%c[WHATSAPP] INSTÂNCIA: ${WA_CONFIG.INSTANCE}`, "color: #555;");
    console.log(`%c[OTP] CÓDIGO GERADO: ${code}`, "background: #25D366; color: white; padding: 10px; border-radius: 8px; font-weight: bold; font-size: 18px;");
    console.log("%c==========================================", "color: #25D366; font-weight: bold;");

    try {
      /**
       * Construção da Query String para GET.
       * Algumas bridges CRMStation usam 'message' e outras 'text'. Enviamos ambos.
       */
      const query = new URLSearchParams({
        action: 'sendText',
        instance: WA_CONFIG.INSTANCE,
        apikey: WA_CONFIG.API_KEY,
        number: cleanNumber,
        text: messageText,
        message: messageText
      }).toString();

      const finalUrl = `${WA_CONFIG.BRIDGE_URL}?${query}`;

      /**
       * O modo 'no-cors' permite que a requisição seja enviada sem o bloqueio de política do mesmo domínio.
       * Como é um GET, o navegador enviará os parâmetros na URL e o servidor processará.
       */
      fetch(finalUrl, { 
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-cache'
      }).then(() => {
        console.log('[VoucherHub] Requisição GET enviada com sucesso para srv6.');
      }).catch(err => {
        console.warn('[VoucherHub] Erro ao tentar enviar via rede:', err);
      });

      // Retornamos true para o fluxo do app prosseguir (o código está no console se falhar a rede)
      return true; 
    } catch (error) {
      console.error('[VoucherHub] Falha ao processar disparo:', error);
      return true; 
    }
  },

  verifyOTP: async (phone: string, inputCode: string): Promise<boolean> => {
    const stored = otpStore.get(phone);
    if (!stored) return false;
    if (Date.now() > stored.expires) return false;
    return stored.code === inputCode;
  }
};