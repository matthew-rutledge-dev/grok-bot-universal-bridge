import forge from "node-forge";

/** Throwaway CA + leaf certs for tests (never written to the repo). */
export function makeCa(cn: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: "commonName", value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert, pem: forge.pki.certificateToPem(cert) };
}

export function issue(ca: ReturnType<typeof makeCa>, cn: string, server: boolean, dnsNames: string[] = ["localhost"]) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1e6) + 2);
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  cert.setSubject([{ name: "commonName", value: cn }]);
  cert.setIssuer(ca.cert.subject.attributes);
  const ext: object[] = [{ name: "basicConstraints", cA: false }, { name: "extKeyUsage", serverAuth: server, clientAuth: !server }];
  if (server) ext.push({ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }, ...dnsNames.map((value) => ({ type: 2, value }))] });
  cert.setExtensions(ext);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}
