# Validação V4 e CORS do Storage — 11/11/2026

## Estado e fronteira de autorização

Não foi identificado um bucket real de testes explicitamente autorizado. As configurações normais não são demo; os buckets citados nos testes são mocks ou projetos `demo-` emulados. Nenhuma credencial foi utilizada para listar buckets ou consultar objetos na nuvem. Ausência de configuração local não prova inexistência de um ambiente externo; falta sua identificação e autorização.

Não criar recursos, alterar IAM/CORS/regras ou usar o bucket normal como substituto. Este documento e o JSON adjacente são propostas, não configuração aplicada. Não foram alterados componentes, credenciais ou regras.

## Evidências comprovadas e limites

- Revisados: storage_inputs.py, storage_results.py, video_access.py, media.py, download.py, privateImages.ts, privateVideoPlayback.ts, inicialização Firebase e relatórios anteriores.
- Materiais Face Swap/referências de vídeo: V4 GET, uma hora, versão validada do objeto.
- Reprodução/download final: V4 GET HTTPS, 30 minutos, versão validada, disposição inline/attachment e MIME. A assinatura não fixa Range.
- Reexecutados nesta etapa: 38 testes backend de vídeo e 72 testes frontend de leitura privada, reprodução e download, todos aprovados. São testes simulados.
- Relatório anterior de MIME: 15 verificações reais SDK/Chrome/Emulator aprovadas para PNG/JPEG/WEBP, decodificação, autorização e liberação de URLs. Isso não valida Cloud Storage publicado.
- Relatório anterior V4: assinatura local com RSA efêmero verificada criptograficamente; não houve aceitação por um serviço Google real.
- Range anterior: bytes corretos e HTTP 206 no emulador; Content-Range existiu no HTTP, mas não foi exposto ao JavaScript. Não equivale a validar streaming ou CORS real.

Não executados no Cloud Storage real: GET assinado, versão após substituição, assinatura adulterada, expiração, attachment, Range, seek, codecs, retomada, mobile e CORS. Não existe resultado positivo ou negativo real para esses cenários nesta etapa.

## Ambiente mínimo para desbloquear

Obter autorização explícita contendo projeto, bucket dedicado, conta de serviço e prefixo sintético descartável. Confirmar ausência de dados de usuários e separação de produção. Identificar quem pode preparar e remover as fixtures; não presumir permissão para criar bucket ou alterar suas políticas.

Para testar SDK Firebase e autenticação ponta a ponta, o bucket deve estar conectado a um projeto Firebase de testes com contas sintéticas. Um bucket GCS isolado é suficiente para V4/HTTP, mas sozinho não prova Firebase Auth/Storage Rules.

O backend de teste deve usar credenciais e configuração do projeto isolado. Para media.py/download.py, usar registros sintéticos em Firestore isolado ou o emulador, nunca o banco normal. O frontend deve apontar para backend local e configuração Firebase de testes. Não iniciar a configuração normal apontada para Render. Nenhum teste deve chamar a DeepSwap.

Separar os privilégios de preparação/limpeza dos privilégios de leitura do backend. Usar apenas PNG/JPEG/WEBP pequenos e um vídeo curto realmente reproduzível, gerados sinteticamente. Não enviar mídia de usuários.

## Permissões e assinatura no Render

O código atual carrega FIREBASE_CREDENTIALS_JSON como Certificate e usa FIREBASE_STORAGE_BUCKET. Necessita chave privada válida de uma conta de serviço ativa, capacidade de assinatura local e storage.objects.get nos objetos/versões autorizados. storage.objects.list, Storage Admin, Editor e acesso público não são necessários para o fluxo de leitura descrito.

A criação/limpeza das fixtures exige permissões próprias, somente no ambiente de testes. As consultas da biblioteca também exigem acesso ao Firestore correto; assinatura Storage não concede esse acesso.

No mecanismo atual com chave privada, não presumir necessidade de iam.serviceAccounts.signBlob. Se futuramente houver assinatura remota/impersonação, serão necessárias API IAM Credentials e a permissão signBlob no signatário, com escopo restrito. Não trocar a estratégia de credenciais nesta validação.

Verificar projeto/bucket, identidade do signatário, chave ativa, horário UTC, conectividade HTTPS e retenção da versão. Remover variáveis de emuladores de ambientes publicados é uma verificação operacional, não uma alteração executada aqui.

## CORS por consumidor

O arquivo storage-cors.test.example.json permite somente a origem local de testes e GET. Não deve ser aplicado a produção. Os headers listados cobrem diagnóstico de respostas e os preflights usados pelo SDK. Validar a resposta de cada endpoint: as APIs JSON/Firebase e XML do GCS não possuem comportamento CORS idêntico.

| Consumidor | Requisição | Requisito |
| --- | --- | --- |
| getMetadata/getBlob | Firebase SDK autenticado; Authorization no formato gerenciado pelo SDK, X-Firebase-Storage-Version, Range no download limitado; X-Firebase-AppCheck se habilitado | Validar preflight e GET na API Firebase efetivamente utilizada; não copiar credenciais para URLs |
| API do backend | Authorization Bearer; POST /media/{item_id}/video-access ou GET /download/{uid}/{id} | CORS do FastAPI/Render é separado do bucket; a origem local 5198 não está na lista normal do backend e precisa de harness isolado próprio |
| Vídeo nativo | GET V4, Range gerenciado pelo navegador | Não envia token Firebase. crossOrigin não é configurado atualmente; reprodução nativa não equivale a fetch/canvas |
| JavaScript diagnóstico | fetch GET V4 com Range | Validar origem, preflight quando houver e exposição de Content-Range, Content-Type, Content-Length, ETag e demais headers consultados |
| Download nativo | Navegação por link V4 attachment | Não precisa de fetch do arquivo completo; Content-Disposition assinado deve produzir anexo/nome corretos |

Para produção, as origens atualmente declaradas no backend são https://xiaswap.com, https://www.xiaswap.com e https://xiaswap.netlify.app. Elas são candidatas para revisão, não autorização para aplicá-las. Origens de desenvolvimento devem ficar separadas. Não usar wildcard ou leitura pública como solução.

GET assinado não autoriza HEAD automaticamente: o método participa da assinatura. O fluxo atual não precisa de uma assinatura HEAD. OPTIONS é preflight automático, não um método a adicionar ao JSON de CORS. CORS não é autorização nem revoga tokens ou assinaturas.

## Roteiro quando o ambiente for autorizado

1. Confirmar projeto/bucket/prefixo/credencial e ausência de dados reais, sem listar dados de produção.
2. Preparar fixtures sintéticas sob caminhos reais do projeto e registrar as gerações retornadas pelo Storage.
3. Validar getBlob como proprietário, anônimo e outro usuário com SDK real e regras do ambiente isolado.
4. Gerar V4 pelos mesmos helpers e testar GET. Registrar apenas status, tamanho, MIME, duração, igualdade dos bytes e identificador local do caso.
5. Alterar apenas a fixture sintética para verificar que a assinatura permanece vinculada à geração anterior, conforme retenção habilitada; nunca passa a ler silenciosamente a nova versão.
6. Adulterar assinatura em memória e validar rejeição. Testar URL expirada produzida apenas no harness, sem mudar o TTL da aplicação. Não exigir um código HTTP específico sem registrar a resposta real.
7. Testar MIME e attachment/nome de arquivo via SDK/backend e navegador real.
8. Testar intervalos inicial, avançado e anterior: 206, Content-Range e bytes esperados. Confirmar SignedHeaders sem Range. Não comprimir o vídeo de maneira que impeça leitura parcial.
9. Testar player real, pausa longa, renovação, posição, volume, logout e sessão trocada. Incluir Chrome/Firefox/Safari e Android/iOS disponíveis; declarar dispositivos não testados.
10. Encerrar o ambiente e remover apenas fixtures sintéticas dentro da autorização de limpeza.

## Logs e pendências

Os módulos novos não imprimem URLs completas; o signatário registra somente categoria de erro. Os testes reexecutados cobrem sanitização. Não foram consultados logs publicados, portanto não se afirma ausência global de vazamentos.

Ainda existe logging genérico de respostas em deepswap.py usado pelo fluxo de imagens, potencialmente expondo URLs privadas do provedor. Isso é uma pendência confirmada no código, fora desta validação; não foi corrigida.

getDownloadURL permanece no salvamento final. VideoGeneration.tsx ainda usa URLs diretas para vídeo recém-gerado, selecionado e listado. A migração desses consumidores deve preceder eventual revogação dos tokens. Nenhum token foi revogado.

## Próximo passo mínimo

Identificar e autorizar o ambiente de testes e seus acessos. Só então executar a matriz real acima. Não há evidência atual que justifique mudar IAM/CORS de produção ou corrigir assinaturas funcionais por hipótese.

Referências oficiais:
- https://cloud.google.com/storage/docs/access-control/signing-urls-with-helpers
- https://cloud.google.com/storage/docs/cross-origin
- https://firebase.google.com/docs/storage/web/download-files
- https://cloud.google.com/storage/docs/xml-api/get-object-download
