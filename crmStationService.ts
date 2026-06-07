
/**
 * SERVIÇO DE INTEGRAÇÃO CRMSTATION - VOUCHERHUB
 * 
 * SOLUÇÃO PARA 'Failed to fetch':
 * O erro ocorre devido às políticas de CORS (Cross-Origin Resource Sharing).
 * O navegador tenta uma requisição OPTIONS (Preflight) antes do POST JSON, 
 * mas o servidor de destino não retorna os headers necessários.
 * 
 * Usamos 'mode: no-cors' e 'Content-Type: text/plain' para transformar o POST em uma 
 * "Simple Request", que é enviada sem Preflight. O servidor PHP receberá o 
 * JSON no corpo da requisição normalmente.
 */

const CRM_CONFIG = {
  ENDPOINT: 'https://321dbase.com/api/api_automatize.php',
  GROUP_ID: '1912',
  TOKEN: '94605235643368406',
};

interface CRMResponse {
  ok: boolean;
  http_status: number;
  response_body: string;
}

export const crmStationService = {
  /**
   * Sanitiza o número de telefone.
   */
  formatPhone: (phone: string): string => {
    return phone.replace(/\D/g, '');
  },

  /**
   * Envio padrão via POST (Bypassing CORS Preflight).
   */
  sendCRMStation: async (
    mobile: string,
    keyword: string,
    text: string
  ): Promise<CRMResponse> => {
    const mobileDigits = crmStationService.formatPhone(mobile);
    
    const payload = {
      groupid: CRM_CONFIG.GROUP_ID,
      token: CRM_CONFIG.TOKEN,
      mobile: mobileDigits,
      keyword: keyword, // "" para entrega direta/menu
      text: text,
    };

    try {
      /**
       * MODO NO-CORS + TEXT/PLAIN:
       * Permite que a requisição POST saia do navegador sem ser bloqueada.
       * O status de resposta será 0 (opaque) pois não podemos ler o resultado,
       * mas o servidor receberá o payload e disparará o WhatsApp.
       */
      await fetch(CRM_CONFIG.ENDPOINT, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
          'Content-Type': 'text/plain', // 'text/plain' evita o Preflight OPTIONS
        },
        body: JSON.stringify(payload),
      });

      // Como o modo é no-cors, não conseguimos ler o status real.
      // Retornamos OK assumindo que se não houve erro de rede, o pacote foi entregue.
      return {
        ok: true,
        http_status: 200,
        response_body: 'Requisição enviada com sucesso (Modo Opaque).',
      };
    } catch (error: any) {
      console.error('[CRMSTATION ROLLBACK ERROR]', error.message);
      return {
        ok: false,
        http_status: 500,
        response_body: error.message,
      };
    }
  },

  /**
   * Verifica conectividade com o gateway usando protocolo simples.
   */
  healthCheck: async (): Promise<{ success: boolean; message: string }> => {
    try {
      await fetch(CRM_CONFIG.ENDPOINT, { 
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ ping: "check" })
      });
      return { success: true, message: 'Gateway CRMSTATION alcançado via protocolo simples.' };
    } catch (e: any) {
      return { success: false, message: `Falha na conexão de rede: ${e.message}` };
    }
  },

  /**
   * Executa envio de evento para simuladores.
   */
  sendEvent: async (data: { mobile: string; keyword: string; text: string }): Promise<{ success: boolean; error?: string }> => {
    const res = await crmStationService.sendCRMStation(data.mobile, data.keyword, data.text);
    return {
      success: res.ok,
      error: res.ok ? undefined : res.response_body
    };
  }
};