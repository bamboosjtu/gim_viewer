export function packageBoundaryError(specifier,dependencies) {
  if(specifier.startsWith('.')&&/(?:^|\/)packages\//.test(specifier))return 'shared packages must use declared package exports';
  if(!specifier.startsWith('@gim/'))return null;
  const name=specifier.split('/').slice(0,2).join('/');
  if(!Object.hasOwn(dependencies,name))return `undeclared shared package ${name}`;
  if(specifier.split('/').some(part=>['..','src','__tests__'].includes(part)))return 'shared package private path bypasses its public exports';
  return null;
}
