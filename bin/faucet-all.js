#!/usr/bin/env node

'use strict';

const {NodeClient} = require('hs-client');
const {Network} = require('hsd');
const assert = require('bsert');
const os = require('os');
const fs = require('bfile');
const request = require('brq');
const Path = require('path');
const bio = require('bufio');
const pgp = require('bcrypto/lib/pgp');
const ssh = require('bcrypto/lib/ssh');
const bech32 = require('bstring/lib/bech32');
const blake2b = require('bcrypto/lib/blake2b');
const sha256 = require('bcrypto/lib/sha256');
const merkle = require('bcrypto/lib/mrkl');
const fixed = require('../lib/fixed');
const AirdropKey = require('../lib/key');
const AirdropProof = require('../lib/proof');
const readline = require('../lib/readline');
const pkg = require('../package.json');
const tree = require('../etc/tree.json');
const faucet = require('../etc/faucet.json');
const {PGPMessage, SecretKey} = pgp;
const {SSHPrivateKey} = ssh;
const {readPassphrase} = readline;

const {
  PUBLIC_KEY,
  PRIVATE_KEY
} = pgp.packetTypes;

// hs-client for sending airdrops
const network = Network.get('simnet');

const clientOptions = {
  network: network.type,
  port: network.rpcPort
};

const client = new NodeClient(clientOptions);

/*
 * Constants
 */

const BUILD_DIR = process.env.BUILD_DIR
               || Path.resolve(os.homedir(), '.hs-tree-data');
const NONCE_DIR = Path.resolve(BUILD_DIR, 'nonces');
const GITHUB_URL = 'https://github.com/handshake-org/hs-tree-data/raw/master';

const {
  checksum: TREE_CHECKSUM,
  leaves: TREE_LEAVES,
  keys: TREE_KEYS,
  checksums: TREE_CHECKSUMS,
  reward: TREE_REWARD
} = tree;

const {
  checksum: FAUCET_CHECKSUM,
  leaves: FAUCET_LEAVES
} = faucet;

// TODO: Separate into another meta json file.
const PROOF_CHECKSUM =
  'f0998ad5fee51173f4258ea155b860ac9faf5ffd437f89f9b8b12c0794a1602f';

// Test address.
const ADDR = 'ts1q5z7yym8xrh4quqg3kw498ngy7hnd4sruqyxnxd';

/*
 * Airdrop
 */

async function readFile(...path) {
  if (!await fs.exists(BUILD_DIR))
    await fs.mkdir(BUILD_DIR, 0o755);

  if (!await fs.exists(NONCE_DIR))
    await fs.mkdir(NONCE_DIR, 0o755);

  const checksum = Buffer.from(path.pop(), 'hex');
  const file = Path.resolve(BUILD_DIR, ...path);
  const base = Path.basename(file);

  if (!await fs.exists(file)) {
    const url = `${GITHUB_URL}/${path.join('/')}`;

    console.log('Downloading: %s...', url);

    const req = await request({
      url,
      limit: 50 << 20,
      timeout: 600 * 1000
    });

    const raw = req.buffer();

    if (!sha256.digest(raw).equals(checksum))
      throw new Error(`Invalid checksum: ${base}`);

    await fs.writeFile(file, raw);

    return raw;
  }

  const raw = await fs.readFile(file);

  if (!sha256.digest(raw).equals(checksum))
    throw new Error(`Invalid checksum: ${base}`);

  return raw;
}

async function readTreeFile() {
  return readFile('tree.bin', TREE_CHECKSUM);
}

async function readFaucetFile() {
  return readFile('faucet.bin', FAUCET_CHECKSUM);
}

async function readNonceFile(index) {
  assert((index & 0xff) === index);
  return readFile('nonces', `${pad(index)}.bin`, TREE_CHECKSUMS[index]);
}

async function readProofFile() {
  const raw = await readFile('proof.json', PROOF_CHECKSUM);
  return JSON.parse(raw.toString('utf8'));
}

async function readLeaves() {
  const data = await readTreeFile();
  const br = bio.read(data);
  const totalLeaves = br.readU32();
  const leaves = [];

  let totalKeys = 0;

  for (let i = 0; i < totalLeaves; i++) {
    const count = br.readU8();
    const hashes = [];

    for (let j = 0; j < count; j++) {
      const hash = br.readBytes(32);
      hashes.push(hash);
      totalKeys += 1;
    }

    leaves.push(hashes);
  }

  assert.strictEqual(br.left(), 0);
  assert.strictEqual(totalKeys, TREE_KEYS);
  assert.strictEqual(totalLeaves, TREE_LEAVES);

  return leaves;
}

function flattenLeaves(leaves) {
  assert(Array.isArray(leaves));

  const out = [];

  for (const hashes of leaves) {
    const root = merkle.createRoot(blake2b, hashes);
    out.push(root);
  }

  return out;
}

function findLeaf(leaves, target) {
  assert(Array.isArray(leaves));
  assert(Buffer.isBuffer(target));

  for (let i = 0; i < leaves.length; i++) {
    const hashes = leaves[i];

    for (let j = 0; j < hashes.length; j++) {
      const hash = hashes[j];

      if (hash.equals(target))
        return [i, j];
    }
  }

  return [-1, -1];
}

async function readFaucetLeaves() {
  const data = await readFaucetFile();
  const br = bio.read(data);
  const totalLeaves = br.readU32();
  const leaves = [];

  for (let i = 0; i < totalLeaves; i++) {
    const hash = br.readBytes(32);
    leaves.push(hash);
  }

  assert.strictEqual(br.left(), 0);
  assert.strictEqual(totalLeaves, FAUCET_LEAVES);

  return leaves;
}

function findFaucetLeaf(leaves, target) {
  assert(Array.isArray(leaves));
  assert(Buffer.isBuffer(target));

  // Could do a binary search here.
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];

    if (leaf.equals(target))
      return i;
  }

  return -1;
}

async function findNonce(key, priv) {
  assert(key instanceof AirdropKey);
  assert((priv instanceof SecretKey)
      || (priv instanceof SSHPrivateKey));

  const bucket = key.bucket();
  const data = await readNonceFile(bucket);
  const br = bio.read(data);

  while (br.left()) {
    const ct = br.readBytes(br.readU16(), true);

    try {
      return key.decrypt(ct, priv);
    } catch (e) {
      continue;
    }
  }

  throw new Error(`Could not find nonce in bucket ${bucket}.`);
}

async function findProofEntry(addr) {
  const target = parseAddress(addr);
  const items = await readProofFile();

  for (const [address, value, sponsor] of items) {
    const {hash} = parseAddress(address);

    if (hash.equals(target.hash))
      return [value, sponsor];
  }

  throw new Error('Address is not a faucet or sponsor address.');
}

async function createProof(key, priv, bare = false) {
  assert(key instanceof AirdropKey);
  assert(typeof bare === 'boolean');

  if (key.isAddress()) {
    const leaves = await readFaucetLeaves();
    const index = findFaucetLeaf(leaves, key.hash());

    if (index === -1)
      throw new Error('Could not find leaf.');

    console.log('Creating proof from leaf...');

    const proof = merkle.createBranch(blake2b, index, leaves);
    const p = new AirdropProof();

    p.index = index;
    p.proof = proof;
    p.key = key.encode();

    return p;
  }

  const leaves = await readLeaves();

  assert(priv);

  console.log('Decrypting nonce...');

  const nonce = await findNonce(key, priv);

  if (bare)
    key.applyNonce(nonce);
  else
    key.applyTweak(nonce);

  console.log('Finding merkle leaf...');

  const [index, subindex] = findLeaf(leaves, key.hash());

  if (index === -1)
    throw new Error('Could not find leaf.');

  console.log('Creating proof from leaf...');

  const subtree = leaves[index];
  const subproof = merkle.createBranch(blake2b, subindex, subtree);

  const tree = flattenLeaves(leaves);
  const proof = merkle.createBranch(blake2b, index, tree);

  const p = new AirdropProof();

  p.index = index;
  p.proof = proof;
  p.subindex = subindex;
  p.subproof = subproof;
  p.key = key.encode();

  return p;
}

async function parsePGP(msg, keyID) {
  assert(msg instanceof PGPMessage);
  assert(Buffer.isBuffer(keyID));

  let priv = null;
  let pub = null;

  for (const pkt of msg.packets) {
    if (pkt.type === PRIVATE_KEY) {
      const key = pkt.body;

      if (key.key.matches(keyID)) {
        priv = key;
        pub = key.key;
        continue;
      }

      continue;
    }

    if (pkt.type === PUBLIC_KEY) {
      const key = pkt.body;

      if (key.matches(keyID)) {
        pub = key;
        continue;
      }

      continue;
    }
  }

  if (!priv && !pub)
    throw new Error(`Could not find key for ID: ${keyID}.`);

  if (!priv) {
    return {
      type: 'pgp',
      pub: AirdropKey.fromPGP(pub),
      priv: null
    };
  }

  let passphrase = null;

  if (priv.params.encrypted) {
    console.log(`I found key ${pgp.encodeID(keyID)}, but it's encrypted.`);

    passphrase = await readPassphrase();
  }

  return {
    type: 'pgp',
    pub: AirdropKey.fromPGP(priv.key),
    priv: priv.secret(passphrase)
  };
}

function getType(arg) {
  assert(typeof arg === 'string');

  const ext = Path.extname(arg);

  switch (ext) {
    case '.asc':
    case '.pgp':
    case '.gpg':
      return 'pgp';
    default:
      return bech32.test(arg) ? 'addr' : 'ssh';
  }
}

async function readKey(file, keyID) {
  assert(typeof file === 'string');
  assert(keyID == null || Buffer.isBuffer(keyID));

  const data = await fs.readFile(file);
  const ext = Path.extname(file);

  switch (ext) {
    case '.asc': {
      assert(keyID);
      const str = data.toString('utf8');
      const msg = PGPMessage.fromString(str);
      return parsePGP(msg, keyID);
    }

    case '.pgp':
    case '.gpg': {
      assert(keyID);
      const msg = PGPMessage.decode(data);
      return parsePGP(msg, keyID);
    }

    default: {
      const str = data.toString('utf8');
      const passphrase = await readPassphrase();
      const key = SSHPrivateKey.fromString(str, passphrase);
      return {
        type: 'ssh',
        pub: AirdropKey.fromSSH(key),
        priv: key
      };
    }
  }
}

function usage() {
  console.error(`hs-airdrop v${pkg.version}`);
  console.error('');
  console.error('This tool will create the proof necessary to');
  console.error('collect your faucet reward, airdrop reward, or');
  console.error('sponsor reward on the Handshake blockchain.');
  console.error('');
  console.error('Usage: $ hs-airdrop [key-file] [id] [addr] [fee] --bare');
  console.error('       $ hs-airdrop [key-file] [addr] [fee] --bare');
  console.error('       $ hs-airdrop [addr]');
  console.error('       $ hs-airdrop [addr] [value/shares]');
  console.error('       $ hs-airdrop [addr] [value] --sponsor');
  console.error('');
  console.error('  [key-file] can be:');
  console.error('    - An SSH private key file.');
  console.error('    - An exported PGP armor keyring (.asc).');
  console.error('    - An exported PGP raw keyring (.pgp/.gpg).');
  console.error('');
  console.error('  [id] is only necessary for PGP keys.');
  console.error('');
  console.error('  [addr] must be a Handshake bech32 address.');
  console.error('  [value] may be the coin value awarded to you (in HNS).');
  console.error('  [shares] may be the num. of shares awarded by the faucet.');
  console.error('  [fee] must be a coin value (in HNS).');
  console.error('');
  console.error('  The --sponsor flag is necessary for project sponsors.');
  console.error('');
  console.error('  The --bare flag will use your existing public key.');
  console.error('  This is not recommended as it makes you identifiable');
  console.error('  on-chain.');
  console.error('');
  console.error('  This tool will provide a JSON representation of');
  console.error('  your airdrop proof as well as a base64 string.');
  console.error('');
  console.error('  The base64 string must be passed to:');
  console.error('    $ hsd-rpc sendrawairdrop "base64-string"');
  console.error('');
  console.error('Examples:');
  console.error(`  $ hs-airdrop ~/.gnupg/secring.gpg 0x12345678 ${ADDR} 0.5`);
  console.error(`  $ hs-airdrop ~/.ssh/id_rsa ${ADDR} 0.5`);
  console.error(`  $ hs-airdrop ~/.ssh/id_rsa ${ADDR} 0.5 --bare`);
  console.error(`  $ hs-airdrop ${ADDR}`);
  console.error(`  $ hs-airdrop ${ADDR} 5000`);
  console.error(`  $ hs-airdrop ${ADDR} 2 # shares`);
  console.error(`  $ hs-airdrop ${ADDR} 1000000 --sponsor`);
  console.error('');
}

function spliceArg(argv, name) {
  assert(Array.isArray(argv));
  assert(typeof name === 'string');

  const i = argv.indexOf(name);

  if (i === -1)
    return false;

  argv.splice(i, 1);

  return true;
}

async function main() {
  let key = null;
  let fee = 0;

  const items = await readProofFile();

  for (const [address, value, sponsor] of items) {
    key = {
      type: 'addr',
      pub: AirdropKey.fromAddress(address, value, sponsor),
      priv: null
    };

    fee = sponsor ? 500e6 : 100e6;

    const addrObj = parseAddress(address);

    console.log(`Attempting to create proof for address: ${address}`);

    const proof = await createProof(key.pub, key.priv, false);

    proof.version = addrObj.version;
    proof.address = addrObj.hash;
    proof.fee = fee;

    if (!proof.verify())
      throw new Error('Proof failed verification.');

    console.log('Sending...');

    const result = await client.execute('sendrawairdrop', [proof.toBase64()]);
    console.log(result);
  }
}

/*
 * Helpers
 */

function pad(index) {
  assert((index & 0xff) === index);

  let str = index.toString(10);

  while (str.length < 3)
    str = '0' + str;

  return str;
}

function parseAddress(addr) {
  const address = bech32.decode(addr);

  if (address.hrp !== 'hs'
      && address.hrp !== 'ts'
      && address.hrp !== 'rs') {
    throw new Error('Invalid address HRP.');
  }

  if (address.version !== 0)
    throw new Error('Invalid address version.');

  if (address.hash.length !== 20
      && address.hash.length !== 32) {
    throw new Error('Invalid address.');
  }

  return address;
}

/*
 * Execute
 */

main().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
