import * as fs from 'fs/promises';
import * as acorn from 'acorn';
import MagicString from 'magic-string';

export async function replaceFunction(filePath, targetFuncName, newFuncCode) {
  const code = await fs.readFile(filePath, 'utf8');
  const magicString = new MagicString(code);

  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });

  let replaced = false;

  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === targetFuncName) {
      magicString.overwrite(node.start, node.end, newFuncCode);
      replaced = true;
      break;
    }

    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (
          decl.id &&
          decl.id.type === 'Identifier' &&
          decl.id.name === targetFuncName &&
          decl.init &&
          (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')
        ) {
          magicString.overwrite(node.start, node.end, newFuncCode);
          replaced = true;
          break;
        }
      }

      if (replaced) {
        break;
      }
    }
  }

  if (!replaced) {
    throw new Error(`Function "${targetFuncName}" not found in ${filePath}`);
  }

  await fs.writeFile(filePath, magicString.toString(), 'utf8');
}

