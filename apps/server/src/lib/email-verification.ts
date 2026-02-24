import { createVerify, createHash } from 'crypto';

const getHeader = (raw: string, name: string): string => {
  const regex = new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n\\S|\\r?\\n\\r?\\n|$)`, 'mi');
  const match = raw.match(regex);
  return match ? match[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
};

const parseParams = (str: string): Record<string, string> => {
  const params: Record<string, string> = {};
  const parts = str.split(';');
  
  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    if (key && valueParts.length > 0) {
      params[key.trim().toLowerCase()] = valueParts.join('=').trim();
    }
  }
  
  return params;
};

const extractDomainFromEmail = (email: string): string | null => {
  const match = email.match(/@([^>\s]+)/);
  return match ? match[1].toLowerCase() : null;
};

const extractIPFromReceived = (received: string): string | null => {
  const patterns = [
    /\[([0-9a-fA-F:.]+)\]/,
    /from\s+[^\s]+\s+\(([0-9a-fA-F:.]+)\)/,
    /by\s+[^\s]+\s+\(([0-9a-fA-F:.]+)\)/
  ];
  
  for (const pattern of patterns) {
    const match = received.match(pattern);
    if (match) return match[1];
  }
  
  return null;
};

// Default timeout for DNS TXT look-ups (in milliseconds)
const DNS_TIMEOUT_MS = 5000;

// Resolve TXT records with a timeout so that slow DNS responses don't hang the verification pipeline.

const resolveTxtSafe = (hostname: string, timeout = DNS_TIMEOUT_MS): Promise<string[][]> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DNS resolveTxt timeout for ${hostname}`)), timeout);
    dns.resolveTxt(hostname)
      .then((records) => {
        clearTimeout(timer);
        resolve(records);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
};

// IPv6 utils

// Expand an IPv6 address to its full 8×16-bit segment representation
const parseIPv6 = (ip: string): number[] => {
  // Split around the double-colon (can appear at most once)
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - (headParts.length + tailParts.length);
  const zeros = Array(Math.max(0, missing)).fill('0');
  const parts = [...headParts, ...zeros, ...tailParts].map((p) => parseInt(p || '0', 16));
  if (parts.length !== 8 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) {
    throw new Error(`Invalid IPv6 address: ${ip}`);
  }
  return parts;
};

const ipv6ToBigInt = (ip: string): bigint => {
  return parseIPv6(ip).reduce<bigint>((acc, part) => (acc << 16n) + BigInt(part), 0n);
};

// Check if an IPv6 address belongs to the supplied CIDR range.
const ipv6CidrMatch = (ip: string, rangeIp: string, prefix = 128): boolean => {
  if (prefix < 0 || prefix > 128) return false;
  const ipBig = ipv6ToBigInt(ip);
  const rangeBig = ipv6ToBigInt(rangeIp);
  // Build a network mask with the first `prefix` bits set to 1
  const networkMask = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix));
  return (ipBig & networkMask) === (rangeBig & networkMask);
};
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
      
      if (mech.startsWith('ip6:')) {
        const [ipRange, cidr] = mech.slice(4).split('/');
        if (ip.includes(':')) {
          const prefix = cidr ? parseInt(cidr, 10) : 128;
          try {
            return ipv6CidrMatch(ip, ipRange, prefix);
          } catch {
            return false;
          }
        }
      }
      
      if (mech.startsWith('include:')) {
        const includeDomain = mech.slice(8);
        try {
          const includeRecords = await resolveTxtSafe(includeDomain);
          const includeSpf = includeRecords.flat().find(r => r.startsWith('v=spf1'));
          if (includeSpf) {
            const includeMechs = includeSpf.split(/\s+/).slice(1);
            for (const includeMech of includeMechs) {
              if (await checkMechanism(includeMech, includeDomain)) return true;
            }
          }
        } catch {
          // Include domain lookup failed        }
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
    
  } catch {
    return undefined;  }
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
