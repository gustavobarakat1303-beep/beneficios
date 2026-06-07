
const SECRET = 'voucherhub-ultra-secret-key-2026';

export const hashSubscriberCode = async (code: string): Promise<string> => {
  // Normalização: remove espaços e converte para maiúsculo
  const cleanCode = code.trim().toUpperCase();
  
  const msgUint8 = new TextEncoder().encode(cleanCode + SECRET);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

export const signVoucher = async (payload: any): Promise<string> => {
  const data = JSON.stringify(payload);
  const msgUint8 = new TextEncoder().encode(data + SECRET);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const signature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return btoa(data) + '.' + signature;
};

export const signVoucherToken = signVoucher;

export const verifyVoucher = async (payloadOrToken: any, signatureStr?: string): Promise<any | boolean | null> => {
  try {
    if (typeof payloadOrToken === 'string') {
      const [encodedData, signature] = payloadOrToken.split('.');
      const dataStr = atob(encodedData);
      const msgUint8 = new TextEncoder().encode(dataStr + SECRET);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const expectedSignature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      
      if (signature === expectedSignature) {
        return JSON.parse(dataStr);
      }
      return null;
    } else {
      const data = JSON.stringify(payloadOrToken);
      const msgUint8 = new TextEncoder().encode(data + SECRET);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const expectedSignature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return signatureStr === expectedSignature;
    }
  } catch (e) {
    return null;
  }
};

export const verifyVoucherToken = verifyVoucher;

export const generateShortCode = (partner: string) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let random = '';
  for (let i = 0; i < 6; i++) random += chars.charAt(Math.floor(Math.random() * chars.length));
  return `${partner.toUpperCase()}-${random}`;
};