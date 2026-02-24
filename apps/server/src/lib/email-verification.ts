import { getHeader, extractDomainFromEmail, extractIPFromReceived, resolveTxtSafe, parseParams } from '../lib/utils';

// SPF Validation
async function validateSPF(domain: string, senderIP: string): Promise<boolean> {
  try {
    const txtRecords = await resolveTxtSafe(`_spf.${domain}`);
    const spfRecord = txtRecords.flat().find(record => record.startsWith('v=spf1'));

    if (!spfRecord) return false;

    const mechanisms = spfRecord.split(' ');

    const checkMechanism = async (mechanism: string, checkDomain: string): Promise<boolean> => {
      if (mechanism === 'all') return false;

      if (mechanism === 'mx') {
        const mxRecords = await resolveTxtSafe(`_spf.${domain}`);
        return mxRecords.flat().some(record => record === senderIP);
      }

      if (mechanism.startsWith('include:')) {
        const includeDomain = mechanism.split(':')[1];
        const includeMechanisms = (await resolveTxtSafe(`_spf.${includeDomain}`)).flat().filter(record => record.startsWith('v=spf1'));
        for (const includeMech of includeMechanisms) {
          if (await checkMechanism(includeMech, includeDomain)) return true;
        }
      }
      
      return false;
    };
    
    for (const mechanism of mechanisms) {
      if (await checkMechanism(mechanism, domain)) return true;
    }
    
    return false;
  } catch {
    return false;
  }
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

// DKIM Validation
async function validateDKIM(rawEmail: string): Promise<boolean> {
  try {
    const dkimHeader = getHeader(rawEmail, 'DKIM-Signature');
    if (!dkimHeader) return false;

    const params = parseParams(dkimHeader);
    const domain = params.d;
    const selector = params.s;
    const signature = params.b;

    if (!domain || !selector || !signature) return false;

    const pubKeyRecords = await resolveTxtSafe(`${selector}._domainkey.${domain}`);
    const pubKeyRecord = pubKeyRecords.flat().find(record => record.startsWith('v=DKIM1'));

    if (!pubKeyRecord) return false;

    const pubKey = pubKeyRecord.split('p=')[1];
    if (!pubKey) return false;

    const signatureInput = getSignatureInput(rawEmail, dkimHeader);
    const verifier = crypto.createVerify('SHA256');
    verifier.update(signatureInput);
    verifier.end();
    
    const pemKey = `-----BEGIN PUBLIC KEY-----\n${pubKey}\n-----END PUBLIC KEY-----`;
    return verifier.verify(pemKey, signature, 'base64');
    
  } catch {
    return false;
  }
}

// DMARC Validation
async function validateDMARC(domain: string): Promise<boolean> {
  try {
    const txtRecords = await resolveTxtSafe(`_dmarc.${domain}`);
    const dmarcRecord = txtRecords.flat().find(record => record.startsWith('v=DMARC1'));
    
    if (!dmarcRecord) return false;
    
    const params = parseParams(dmarcRecord);
    const policy = params.p;
    
    // Require strict policy (quarantine or reject)
    return policy === 'quarantine' || policy === 'reject';
    
  } catch {
    return false;
  }
}

// BIMI Validation
async function validateBIMI(domain: string): Promise<boolean> {
  try {
    console.log(`[BIMI_DEBUG] Validating BIMI for domain: ${domain}`);
    
    // Try exact domain first
    console.log(`[BIMI_DEBUG] Checking default._bimi.${domain}`);
    try {
      const txtRecords = await resolveTxtSafe(`default._bimi.${domain}`);
      const bimiRecord = txtRecords.flat().find(record => record.startsWith('v=BIMI1'));
      
      if (bimiRecord) {
        const params = parseParams(bimiRecord);
        const logoUrl = params.l;
        if (logoUrl) {
          console.log(`[BIMI_DEBUG] Found BIMI logo: ${logoUrl}`);
          return true;
        }
      }
    } catch {
      // ignore
    }
    
    // Try _bimi.${domain} as fallback
    console.log(`[BIMI_DEBUG] Checking _bimi.${domain}`);
    try {
      const txtRecords = await resolveTxtSafe(`_bimi.${domain}`);
      const bimiRecord = txtRecords.flat().find(record => record.startsWith('v=BIMI1'));
      
      if (bimiRecord) {
        const params = parseParams(bimiRecord);
        const logoUrl = params.l;
        if (logoUrl) {
          console.log(`[BIMI_DEBUG] Found BIMI logo: ${logoUrl}`);
          return true;
        }
      }
    } catch {
      // ignore
    }
    
    return false;
  } catch {
    return false;
  }
}

// Extract domain from email address
function extractDomainFromEmail(email: string): string | null {
  const match = email.match(/@([^@]+)$/);
  return match ? match[1] : null;
}

// Extract IP from Received header
function extractIPFromReceived(receivedHeader: string | null): string | null {
  if (!receivedHeader) return null;
  
  const ipMatch = receivedHeader.match(/\[([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\]/);
  return ipMatch ? ipMatch[1] : null;
}

// Get signature input for DKIM validation
function getSignatureInput(rawEmail: string, dkimHeader: string): string {
  const headers = rawEmail.split('\r\n\r\n')[0];
  const dkimFields = dkimHeader.split(';').map(f => f.trim()).filter(f => f.startsWith('b=') || f.startsWith('z='));
  
  let input = '';
  for (const field of dkimFields) {
    const [key, value] = field.split('=');
    if (key === 'b' || key === 'z') {
      input += `${key}:${value}\r\n`;
    }
  }
  
  return input.trim();
}

// Main verification function
export async function verify(rawEmail: string): Promise<{isVerified: boolean; logoUrl?: string}> {
  try {
    // Extract sender domain
    const fromHeader = getHeader(rawEmail, 'From');
    const domain = extractDomainFromEmail(fromHeader);
    
    if (!domain) {
      return { isVerified: false };
    }

    const receivedHeader = getHeader(rawEmail, 'Received');
    const senderIP = extractIPFromReceived(receivedHeader);
    
    // Run validations in parallel
    const [spfValid, dkimValid, dmarcValid, bimiValid] = await Promise.all([
      senderIP ? validateSPF(domain, senderIP).catch(() => {
        return false;
      }) : Promise.resolve(false),
      validateDKIM(rawEmail).catch(() => {
        return false;
      }),
      validateDMARC(domain).catch(() => {
        return false;
      }),
      validateBIMI(domain).catch(() => {
        return false;
      }),
    ]);

    const authValid = dkimValid || spfValid || dmarcValid;
    
    // Gmail requires both email authentication AND BIMI validation btw
    console.log(`[VERIFY_DEBUG] Domain: ${domain}, SPF: ${spfValid}, DKIM: ${dkimValid}, DMARC: ${dmarcValid}, BIMI: ${bimiValid}`);
    const isVerified = authValid && bimiValid;
    console.log(`[VERIFY_DEBUG] Final verification result for ${domain}: ${isVerified} (auth: ${authValid}, bimi: ${bimiValid})`);

    if (isVerified) {
      // Get BIMI logo URL
      try {
        const txtRecords = await resolveTxtSafe(`default._bimi.${domain}`);
        const bimiRecord = txtRecords.flat().find(record => record.startsWith('v=BIMI1'));
        if (bimiRecord) {
          const params = parseParams(bimiRecord);
          const logoUrl = params.l;
          if (logoUrl) {
            return { isVerified: true, logoUrl };
          }
        }
      } catch {
        // ignore
      }
    }
    
    return { isVerified };
  } catch {
    return { isVerified: false };
  }
}
