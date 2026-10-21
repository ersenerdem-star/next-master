import {resolve} from 'node:path';

// Netlify's workspace base can differ from the wrapper's cwd. Resolve explicit
// artifact paths before the CLI applies that base, so functions are not omitted.
export function absoluteNetlifyDeployPaths(command,root){
 const args=[...command];
 if(!args.some(v=>v==='deploy'))return args;
 for(let i=0;i<args.length;i++){
  if(['--dir','-d','--functions','-f'].includes(args[i])&&args[i+1]&&!args[i+1].startsWith('-'))args[++i]=resolve(root,args[i]);
  else if(/^--(?:dir|functions)=/.test(args[i])){const split=args[i].indexOf('=');args[i]=args[i].slice(0,split+1)+resolve(root,args[i].slice(split+1));}
 }
 return args;
}
