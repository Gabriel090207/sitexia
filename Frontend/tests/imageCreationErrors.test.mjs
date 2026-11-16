import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const module={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/generationErrors.ts',import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023},
}).outputText,{module,exports:module.exports,Error,TypeError,require:()=>({isAxiosError:error=>error?.isAxiosError===true})});
const message=module.exports.getGenerationErrorMessage;
for(const [status,detail]of [
    [502,'O provedor não aceitou a solicitação de geração de imagem.'],
    [503,'O provedor não aceitou a solicitação, mas não foi possível confirmar a liberação da reserva. Não inicie outra geração para substituir esta tentativa.'],
    [502,'Não foi possível confirmar a criação da imagem. A tarefa ou reserva pode existir. Não inicie outra geração para substituir esta tentativa.'],
])test(`image creation HTTP ${status} exposes only controlled application detail`,()=>{
    assert.equal(message({isAxiosError:true,response:{status,data:{detail}}},'fallback'),detail);
});
test('untrusted provider text and unknown codes remain hidden',()=>{
    for(const detail of ['private-prompt private-token',{code:'unknown',message:'private-token'}]){
        const result=message({isAxiosError:true,response:{status:502,data:{detail}}},'fallback');
        assert.equal(result,'O serviço de geração está temporariamente indisponível. Tente novamente em alguns instantes.');
        assert.doesNotMatch(result,/private/);
    }
});
