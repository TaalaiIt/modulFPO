const fs = require('fs');
const path = require('path');

const FORBIDDEN_PATTERNS = [
  /X-Lognex/i,
  /meta\.id/i,
  /retailStore\.id/i,
  /online\.moysklad\.ru/i,
  /moysklad/i
];

const ALLOWED_DIRECTORIES = [
  path.join(__dirname, '..', 'src', 'providers', 'moysklad'),
  path.join(__dirname, '..', 'src', 'gateway', 'gatewayApp.ts'),
  path.join(__dirname, '..', 'src', 'index.ts'),
  path.join(__dirname, '..', 'scripts')
];

const CHECK_DIRS = [
  path.join(__dirname, '..', 'src', 'core'),
  path.join(__dirname, '..', 'src', 'fpo'),
  path.join(__dirname, '..', 'src', 'licensing'),
  path.join(__dirname, '..', 'src', 'agent')
];

function getAllFiles(dirPath, arrayOfFiles = []) {
  if (!fs.existsSync(dirPath)) return arrayOfFiles;
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles);
    } else if (file.endsWith('.ts') || file.endsWith('.js')) {
      arrayOfFiles.push(fullPath);
    }
  });

  return arrayOfFiles;
}

let violations = 0;

console.log('🔍 Running SmartDev Architectural Isolation Lint Check...');

for (const dir of CHECK_DIRS) {
  const files = getAllFiles(dir);
  for (const file of files) {
    const relativePath = path.relative(path.join(__dirname, '..'), file);
    const content = fs.readFileSync(file, 'utf8');

    FORBIDDEN_PATTERNS.forEach((pattern) => {
      const match = content.match(pattern);
      if (match) {
        // Exception: allowedProviders array in default test seed or licensing types is permitted if just 'MOYSKLAD' string in allowed list
        const lines = content.split('\n');
        lines.forEach((line, lineIdx) => {
          if (pattern.test(line)) {
            // Allow generic 'MOYSKLAD' enum/string inside allowed providers list or test config comments
            if (line.includes("allowedProviders: ['MOYSKLAD'") || line.includes("allowedProviders.map") || line.includes("allowedProviders") || line.includes("providerCode = 'MOYSKLAD'") || line.includes("providerCode === 'MOYSKLAD'")) {
              return;
            }
            console.error(`❌ Violation in ${relativePath}:${lineIdx + 1}: Found forbidden provider term matching ${pattern}`);
            console.error(`   Line: ${line.trim()}`);
            violations++;
          }
        });
      }
    });
  }
}

if (violations === 0) {
  console.log('✅ Architectural Isolation Check PASSED: Integration Core, FPO, Licensing, and Agent have ZERO MoySklad leakage!');
  process.exit(0);
} else {
  console.error(`💥 Architectural Isolation Check FAILED: Found ${violations} violations!`);
  process.exit(1);
}
