
import { Campaign, Voucher, WhitelistEntry, VoucherStatus, EligibilityMode, EstablishmentUnit } from '../types';
import { useState, useEffect } from 'react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, getDocs, query, where, writeBatch, deleteDoc, onSnapshot, getDocFromServer } from 'firebase/firestore';

import firebaseConfig from '../firebase-applet-config.json';

let app;
try {
  app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
} catch (e) {
  console.warn("Firebase Init Warning:", e);
}

const firestore = app ? getFirestore(app, firebaseConfig.firestoreDatabaseId) : null;

const STORAGE_KEYS = {
  CAMPAIGNS: 'vh_campaigns',
  WHITELIST: 'vh_whitelist',
  VOUCHERS: 'vh_vouchers',
  UNITS: 'vh_units'
};

// Cache em memória para performance
const cache: Record<string, any[] | null> = {
  [STORAGE_KEYS.CAMPAIGNS]: null,
  [STORAGE_KEYS.WHITELIST]: null,
  [STORAGE_KEYS.VOUCHERS]: null,
  [STORAGE_KEYS.UNITS]: null
};

// Listeners para reatividade no React
const listeners: Set<() => void> = new Set();
export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const notify = () => listeners.forEach(fn => fn());

export const useDataSync = () => {
  const [, setVersion] = useState(0);
  useEffect(() => {
    return subscribe(() => setVersion(v => v + 1));
  }, []);
};

// Map para busca ultra-rápida de whitelist (Código -> Entry)
let whitelistMap: Map<string, WhitelistEntry> | null = null;
// Map para busca ultra-rápida de vouchers (Código_Campaign_Month -> Voucher)
let voucherMap: Map<string, Voucher> | null = null;

const get = <T>(key: string): T[] => {
  if (cache[key] && (key !== STORAGE_KEYS.WHITELIST || whitelistMap)) return cache[key] as T[];
  
  const raw = localStorage.getItem(key);
  const data = raw ? JSON.parse(raw) : [];
  cache[key] = data;
  
  if (key === STORAGE_KEYS.WHITELIST) {
    whitelistMap = new Map();
    data.forEach((e: WhitelistEntry) => {
      const cleanCode = (e.code || '').trim().toUpperCase();
      whitelistMap!.set(`${cleanCode}_${e.campaignId || 'global'}`, e);
    });
  }

  if (key === STORAGE_KEYS.VOUCHERS) {
    voucherMap = new Map();
    data.forEach((v: Voucher) => {
      const monthKey = (v.issuedAt || '').substring(0, 7);
      const cleanCode = (v.customerCode || '').trim().toUpperCase();
      voucherMap!.set(`${cleanCode}_${v.campaignId}_${monthKey}`, v);
    });
  }
  
  return data;
};

const set = (key: string, val: any) => {
  localStorage.setItem(key, JSON.stringify(val));
  cache[key] = val;
  
  if (key === STORAGE_KEYS.WHITELIST) {
    whitelistMap = new Map();
    val.forEach((e: WhitelistEntry) => {
      const cleanCode = (e.code || '').trim().toUpperCase();
      whitelistMap!.set(`${cleanCode}_${e.campaignId || 'global'}`, e);
    });
  }

  if (key === STORAGE_KEYS.VOUCHERS) {
    voucherMap = new Map();
    val.forEach((v: Voucher) => {
      const monthKey = (v.issuedAt || '').substring(0, 7);
      const cleanCode = (v.customerCode || '').trim().toUpperCase();
      voucherMap!.set(`${cleanCode}_${v.campaignId}_${monthKey}`, v);
    });
  }

  // Notifica componentes React sobre a mudança
  notify();
};

export const db = {
  clearAll: () => {
    localStorage.clear();
    whitelistMap = null;
    voucherMap = null;
    window.location.reload();
  },
  units: {
    all: () => get<EstablishmentUnit>(STORAGE_KEYS.UNITS),
    getById: (id: string) => get<EstablishmentUnit>(STORAGE_KEYS.UNITS).find(u => u.id === id),
    save: (u: EstablishmentUnit, syncFirestore = true) => {
      const all = get<EstablishmentUnit>(STORAGE_KEYS.UNITS);
      const index = all.findIndex(x => x.id === u.id);
      if (index > -1) all[index] = u; else all.push(u);
      set(STORAGE_KEYS.UNITS, all);
      
      if (firestore && syncFirestore) {
        setDoc(doc(firestore, 'units', u.id), u)
          .catch(e => console.warn("Firestore Unit Sync Error:", e));
      }
    },
    delete: (id: string) => {
      const filtered = get<EstablishmentUnit>(STORAGE_KEYS.UNITS).filter(u => u.id !== id);
      set(STORAGE_KEYS.UNITS, filtered);
      
      if (firestore) {
        deleteDoc(doc(firestore, 'units', id))
          .catch(e => console.warn("Firestore Unit Delete Error:", e));
      }
    }
  },
  campaigns: {
    all: () => get<Campaign>(STORAGE_KEYS.CAMPAIGNS),
    getById: (id: string) => get<Campaign>(STORAGE_KEYS.CAMPAIGNS).find(c => c.id === id),
    save: (c: Campaign, syncFirestore = true) => {
      const all = get<Campaign>(STORAGE_KEYS.CAMPAIGNS);
      const index = all.findIndex(x => x.id === c.id);
      if (index > -1) all[index] = c; else all.push(c);
      set(STORAGE_KEYS.CAMPAIGNS, all);

      if (firestore && syncFirestore) {
        setDoc(doc(firestore, 'campaigns', c.id), c)
          .catch(e => console.warn("Firestore Campaign Sync Error:", e));
      }
    },
    delete: (id: string) => {
      const filtered = get<Campaign>(STORAGE_KEYS.CAMPAIGNS).filter(c => c.id !== id);
      set(STORAGE_KEYS.CAMPAIGNS, filtered);

      if (firestore) {
        deleteDoc(doc(firestore, 'campaigns', id))
          .catch(e => console.warn("Firestore Campaign Delete Error:", e));
      }
    }
  },
  whitelist: {
    all: () => get<WhitelistEntry>(STORAGE_KEYS.WHITELIST),
    findEntry: async (code: string, campaignId?: string) => {
      const clean = (code || '').trim().toUpperCase();
      
      // 1. Tenta busca no cache local/Map (Instantâneo)
      if (!whitelistMap) get(STORAGE_KEYS.WHITELIST);
      
      if (campaignId) {
        const entry = whitelistMap?.get(`${clean}_${campaignId}`);
        if (entry) return entry;
      }
      
      const globalEntry = whitelistMap?.get(`${clean}_global`);
      if (globalEntry) return globalEntry;

      // 2. Se não encontrou localmente, busca no Firestore (Lazy Load)
      if (firestore) {
        try {
          const docId = `${clean}_${campaignId || 'global'}`;
          const docSnap = await getDoc(doc(firestore, 'whitelist', docId));
          
          if (docSnap.exists()) {
            const entry = docSnap.data() as WhitelistEntry;
            // Atualiza cache local
            const current = get<WhitelistEntry>(STORAGE_KEYS.WHITELIST);
            if (!current.find(e => e.code === entry.code && e.campaignId === entry.campaignId)) {
              set(STORAGE_KEYS.WHITELIST, [...current, entry]);
            }
            return entry;
          }

          // Se for uma busca por campanha mas não encontrou, tenta buscar global no Firestore
          if (campaignId) {
            const globalDocSnap = await getDoc(doc(firestore, 'whitelist', `${clean}_global`));
            if (globalDocSnap.exists()) {
              const entry = globalDocSnap.data() as WhitelistEntry;
              return entry;
            }
          }
        } catch (e) {
          console.warn("[DB] Erro ao buscar whitelist no Firestore:", e);
        }
      }
      
      return null;
    },
    addBatch: (entries: WhitelistEntry[]) => {
      const current = get<WhitelistEntry>(STORAGE_KEYS.WHITELIST);
      
      // Normaliza identificadores na entrada para acelerar buscas futuras
      const normalizedEntries = entries.map(e => ({
        ...e,
        code: (e.code || '').trim().toUpperCase()
      }));

      const unique = Array.from(new Map([...current, ...normalizedEntries].map(e => {
        const key = `${e.code}_${e.campaignId || 'global'}`;
        return [key, e];
      })).values());
      
      set(STORAGE_KEYS.WHITELIST, unique);

      // Sincronização em lote com Firestore
      if (firestore && normalizedEntries.length > 0) {
        const batch = writeBatch(firestore);
        normalizedEntries.forEach(e => {
          const docId = `${e.code}_${e.campaignId || 'global'}`;
          batch.set(doc(firestore, 'whitelist', docId), e);
        });
        batch.commit().catch(e => console.warn("Firestore Whitelist Batch Error:", e));
      }
    }
  },
  vouchers: {
    getByCode: async (code: string): Promise<Voucher | null> => {
      const normalized = (code || '').trim().toUpperCase();
      
      // 1. Tenta buscar no cache local primeiro (Instantâneo)
      const localVoucher = get<Voucher>(STORAGE_KEYS.VOUCHERS).find(v => v.code === normalized);
      if (localVoucher) return localVoucher;

      // 2. Se não estiver no local, busca no Firestore com timeout
      if (firestore) {
        try {
          // Criamos uma promessa de timeout para não travar a UI
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 3000));
          const fetchPromise = getDoc(doc(firestore, 'vouchers', normalized));
          
          const docSnap: any = await Promise.race([fetchPromise, timeoutPromise]);
          
          if (docSnap.exists()) {
            const data = docSnap.data() as Voucher;
            // Salva no local para futuras buscas rápidas
            const current = get<Voucher>(STORAGE_KEYS.VOUCHERS);
            if (!current.find(v => v.id === data.id)) {
              set(STORAGE_KEYS.VOUCHERS, [...current, data]);
            }
            return data;
          }
        } catch (e) { 
          console.warn("Firestore Fetch Error or Timeout:", e); 
        }
      }
      
      return null;
    },
    checkMonthlyExists: async (customerCode: string, campaignId: string, monthKey: string): Promise<Voucher | null> => {
      if (!voucherMap) get(STORAGE_KEYS.VOUCHERS);
      const clean = (customerCode || '').trim().toUpperCase();
      return voucherMap?.get(`${clean}_${campaignId}_${monthKey}`) || null;
    },
    save: async (v: Voucher) => {
      const normalized = (v.code || '').trim().toUpperCase();
      
      // Sincronização com Firestore em background (não bloqueia a UI)
      if (firestore) {
        setDoc(doc(firestore, 'vouchers', normalized), { ...v, code: normalized })
          .catch(e => console.warn("Firestore Sync Error (Silent):", e));
      }

      const current = get<Voucher>(STORAGE_KEYS.VOUCHERS);
      const updated = [...current, v];
      set(STORAGE_KEYS.VOUCHERS, updated);
    },
    updateStatus: async (code: string, status: VoucherStatus, unitId: string) => {
      const normalized = (code || '').trim().toUpperCase();
      const usedAt = new Date().toISOString();

      // 1. Atualização em background para o Firestore
      if (firestore) {
        updateDoc(doc(firestore, 'vouchers', normalized), { 
          status, 
          usedAt, 
          usedStore: unitId 
        }).catch(e => console.warn("Firestore Update Error (Silent):", e));
      }

      // 2. Atualização local imediata
      const all = get<Voucher>(STORAGE_KEYS.VOUCHERS);
      const idx = all.findIndex(v => v.code === normalized);
      if (idx > -1) {
        all[idx].status = status;
        all[idx].usedAt = usedAt;
        all[idx].usedStore = unitId;
        set(STORAGE_KEYS.VOUCHERS, all);
      }
    },
    all: () => get<Voucher>(STORAGE_KEYS.VOUCHERS),
  },
  audit: {
    log: (userId: string, action: string, type: string, id: string, meta: any) => {
      console.log(`[AUDIT] ${action} | ${type}:${id}`, meta);
    }
  }
};

export const initializeDB = async () => {
  const withTimeout = (promise: Promise<any>, ms: number) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
    ]);
  };

  let syncSuccess = false;

  // 1. Tentar sincronizar do Firestore (Sempre buscar a versão mais recente para Campanhas e Unidades)
  if (firestore) {
    console.log("[DB] Iniciando sincronização com Firestore:", firebaseConfig.projectId);
    
    // Teste de Conexão
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(firestore, 'test', 'connection'));
        console.log("[DB] Conexão com Firestore OK.");
      } catch (error: any) {
        if (error.message?.includes('offline')) {
          console.error("[DB] ERRO: O cliente está offline. Verifique a configuração do Firebase.");
        } else {
          console.log("[DB] Teste de conexão (ignorado se coleção não existir):", error.message);
        }
      }
    };
    testConnection();

    // Configurar Listeners em Tempo Real para Campanhas e Unidades
    // Isso garante que mudanças em um navegador reflitam nos outros instantaneamente
    onSnapshot(collection(firestore, 'campaigns'), (snapshot) => {
      const remoteCamp = snapshot.docs.map(d => d.data() as Campaign);
      set(STORAGE_KEYS.CAMPAIGNS, remoteCamp);
      console.log("[DB] Campanhas atualizadas via Real-time Sync:", remoteCamp.length);
    }, (err) => {
      console.error("[DB] Erro crítico no listener de Campanhas:", err);
      if (err.message.includes('permission-denied')) {
        console.error("[DB] DICA: Verifique se as firestore.rules foram publicadas corretamente.");
      }
    });

    onSnapshot(collection(firestore, 'units'), (snapshot) => {
      const remoteUnits = snapshot.docs.map(d => d.data() as EstablishmentUnit);
      set(STORAGE_KEYS.UNITS, remoteUnits);
      console.log("[DB] Unidades atualizadas via Real-time Sync:", remoteUnits.length);
    }, (err) => console.error("[DB] Erro crítico no listener de Unidades:", err));

    try {
      // Sincronização Inicial (One-time fetch para garantir que temos dados antes de liberar a UI)
      const snapCamp = await withTimeout(getDocs(collection(firestore, 'campaigns')), 5000) as any;
      const remoteCamp = snapCamp.docs.map((d: any) => d.data() as Campaign);
      
      if (remoteCamp.length > 0) {
        set(STORAGE_KEYS.CAMPAIGNS, remoteCamp);
        console.log("[DB] Campanhas sincronizadas com sucesso (Initial Fetch):", remoteCamp.length);
        syncSuccess = true;
      }

      const snapUnits = await withTimeout(getDocs(collection(firestore, 'units')), 5000) as any;
      const remoteUnits = snapUnits.docs.map((d: any) => d.data() as EstablishmentUnit);
      
      if (remoteUnits.length > 0) {
        set(STORAGE_KEYS.UNITS, remoteUnits);
        console.log("[DB] Unidades sincronizadas com sucesso (Initial Fetch):", remoteUnits.length);
        syncSuccess = true;
      }

      // REMOVIDO: Sincronização total da Whitelist no startup (Muito lento)
      // A busca agora é feita sob demanda (Lazy Load) no findEntry
    } catch (e) {
      console.warn("[DB] Falha na sincronização inicial (Usando dados locais):", e);
    }
  } else {
    console.error("[DB] Firestore não inicializado. Verifique as configurações.");
  }

  // 2. Se ainda estiver vazio e a sincronização NÃO teve sucesso (ex: sem internet ou primeira execução sem Firestore)
  // Usamos syncSuccess para evitar sobrescrever o Firestore com padrões se ele estiver apenas vazio mas acessível
  if (db.units.all().length === 0 && !syncSuccess) {
    const initialUnits: EstablishmentUnit[] = [
      { id: 'unit-nomade', name: 'Nômade Coffee', address: 'Rua das Flores, 123', city: 'São Paulo', active: true },
      { id: 'unit-manga', name: 'Pé de Manga', address: 'Praça dos Omaguás, 18', city: 'São Paulo', active: true }
    ];
    // Salva apenas localmente durante a inicialização
    initialUnits.forEach(u => db.units.save(u, false));
  }

  if (db.whitelist.all().length === 0 && !syncSuccess) {
    db.whitelist.addBatch([
      { code: 'UOL123456', name: 'Usuário de Teste' },
      { code: 'UOL654321', name: 'Admin VoucherHub' }
    ]);
  }

  if (db.campaigns.all().length === 0 && !syncSuccess) {
    const initialCampaigns: Campaign[] = [
      {
        id: 'camp-uol-2026',
        name: 'Benefício Exclusivo UOL',
        partner: 'UOL',
        value: 270.0,
        totalLimit: 1000,
        monthlyLimit: 100,
        hardStopDate: '2027-12-31T23:59:59',
        active: true,
        eligibilityMode: EligibilityMode.WHITELIST,
        requirePreRegisteredPhone: false,
        allowedUnits: ['unit-nomade', 'unit-manga'],
        limitPerCodePerMonth: 1,
        months: [],
        benefit_type: 'fixed_amount',
        benefit_value: 270.0,
        rules_text: 'Válido para consumo no local. Não cumulativo.'
      }
    ];
    // Salva apenas localmente durante a inicialização
    initialCampaigns.forEach(c => db.campaigns.save(c, false));
  }
};

export const salvarVoucherCloudRun = async (voucher: any) => {
  console.log("[AGENT] Simulando Cloud Run...", voucher);
  return { success: true, id: Math.random().toString(36).substr(2, 9) };
};