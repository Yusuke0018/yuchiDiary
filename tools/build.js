const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const ASSETS_TO_HASH = [
  {
    relativePath: path.join('scripts', 'app.js'),
    searchTokens: ['./scripts/app.js', 'scripts/app.js'],
  },
  {
    relativePath: 'styles.css',
    searchTokens: ['./styles.css', 'styles.css'],
  },
];

async function cleanDist() {
  await fs.promises.rm(DIST_DIR, { recursive: true, force: true });
}

async function copyPublic() {
  await fs.promises.cp(PUBLIC_DIR, DIST_DIR, { recursive: true });
}

function computeHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 10);
}

async function hashAsset(relativePath) {
  const sourcePath = path.join(DIST_DIR, relativePath);
  const buffer = await fs.promises.readFile(sourcePath);
  const hash = computeHash(buffer);
  const parsed = path.parse(sourcePath);
  const hashedName = `${parsed.name}.${hash}${parsed.ext}`;
  const hashedPath = path.join(parsed.dir, hashedName);
  await fs.promises.rename(sourcePath, hashedPath);
  return {
    originalPath: relativePath.replace(/\\/g, '/'),
    hashedPath: path.relative(DIST_DIR, hashedPath).replace(/\\/g, '/'),
    hash,
  };
}

async function applyHashing() {
  const results = [];
  for (const asset of ASSETS_TO_HASH) {
    const originalFullPath = path.join(DIST_DIR, asset.relativePath);
    try {
      await fs.promises.access(originalFullPath, fs.constants.F_OK);
    } catch (error) {
      console.warn(`Skipping missing asset: ${asset.relativePath}`, error);
      continue;
    }
    const hashed = await hashAsset(asset.relativePath);
    results.push({ ...asset, ...hashed });
  }
  return results;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function rewriteIndex(assetMappings) {
  const indexPath = path.join(DIST_DIR, 'index.html');
  let content = await fs.promises.readFile(indexPath, 'utf8');
  for (const mapping of assetMappings) {
    const replacements = new Set(mapping.searchTokens || []);
    replacements.add(mapping.originalPath);
    for (const token of replacements) {
      if (!token) continue;
      const pattern = new RegExp(escapeRegExp(token), "g");
      const replacement = token.startsWith("./") ? `./${mapping.hashedPath}` : mapping.hashedPath;
      content = content.replace(pattern, replacement);
    }
  }
  await fs.promises.writeFile(indexPath, content, 'utf8');
}

async function writeVersionFile(assetMappings) {
  const versionPath = path.join(DIST_DIR, 'version.txt');
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: ROOT_DIR })
      .toString()
      .trim();
  } catch (error) {
    console.warn('Unable to read git commit id:', error.message);
  }
  const shortCommit = commit && commit !== 'unknown' ? commit.slice(0, 7) : commit;
  const builtAt = new Date().toISOString();
  const assets = assetMappings.reduce((acc, mapping) => {
    acc[mapping.originalPath] = {
      file: mapping.hashedPath,
      hash: mapping.hash,
    };
    return acc;
  }, {});
  const descriptor = {
    version: `${shortCommit}-${builtAt}`,
    commit,
    shortCommit,
    builtAt,
    assets,
  };
  await fs.promises.writeFile(
    versionPath,
    `${JSON.stringify(descriptor, null, 2)}\n`,
    'utf8'
  );
}

async function main() {
  try {
    await cleanDist();
    await copyPublic();
    const assetMappings = await applyHashing();
    await rewriteIndex(assetMappings);
    await writeVersionFile(assetMappings);
    console.info('Build completed.');
  } catch (error) {
    console.error('Build failed:', error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
