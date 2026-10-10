# rc-web: análise de conectividade rodando 100% no navegador

## Contexto
O rc2 (R + C++ + DuckDB spatial) ficou rápido. A ideia é oferecer a mesma análise num site estático: a pessoa abre a página, carrega os dados (ou o exemplo do Ebro), avança passo a passo e vê os resultados (mapa + tabelas). Tudo roda localmente no navegador. Não há servidor nem R.
- **Repo novo e separado.** O rc2 serve só como referência de código e como gerador dos resultados-ouro.
- **Requisito único:** produzir os mesmos números do rc2/rc, com tolerância de 1e-10.
- Este plano é executado em outra conversa. Código de referência: `<path to the rc2 sources>` (abaixo, `RC2/`).

## Veredito: viável hoje
- **Núcleo C++:** ~490 linhas de C++17 puro (`RC2/src/dp.h` já não usa R). As únicas amarras são o Rcpp, o RcppParallel e `R::pnorm`. Compila com Emscripten para WebAssembly sem dificuldade.
- **Geoprocessamento:** já é SQL puro de DuckDB spatial. O duckdb-wasm carrega a extensão spatial, que traz GDAL e PROJ embutidos. Dá para reaproveitar as mesmas queries quase literalmente.
- **Porte:** o resto da lógica R vira TypeScript (montagem do índice, atalho O(1) do leave-one-out, cenários). São algumas centenas de linhas.
- **Teste:** o Ebro (`RC2/inst/extdata/ebro.gpkg`, 1,7 MB, 4985 trechos, 224 barragens) é pequeno. Roda em segundos mesmo em modo serial.
- **Riscos a validar primeiro (Fase 0):**
  - leitura de GPKG via `ST_Read` no duckdb-wasm (há issues abertas: duckdb-wasm #1793 e #2005);
  - registro de arquivo local do usuário (`registerFileHandle` falhou para alguns; usar `registerFileBuffer`).

## Arquitetura
```
index.html (Vite + TypeScript, site estático)
 ├─ UI: wizard passo a passo + mapa MapLibre GL + tabelas
 └─ Web Worker "engine" (não trava a UI)
     ├─ duckdb-wasm + extensão spatial (versão FIXADA)  → pipeline geo (SQL)
     ├─ rc_core.wasm (Emscripten + embind)               → topologia, DP, LOO, bounded
     └─ engine/*.ts                                      → porte da lógica R (index/dindex/spec)
```
- **Stack:** Vite, TypeScript, `@duckdb/duckdb-wasm` (versão fixada após o spike), Emscripten (emsdk), MapLibre GL JS, Comlink (RPC com o worker) e Vitest (testes em Node carregando o mesmo wasm).
- **Paralelismo:**
  - v1 é serial dentro de um Worker.
  - v2 usa um pool de N Web Workers, cada um com sua instância de `rc_core.wasm`. Os cenários de barreira do LOO são divididos entre eles.
  - Isso dispensa SharedArrayBuffer e os headers COOP/COEP, então funciona em GitHub Pages ou em qualquer host estático.
  - Não usar pthreads do Emscripten.
- **Licenças:** todas as dependências são MIT, Apache ou BSD. Nada de GPL.

## Mapa de porte (fonte → destino)
**C++ → `core/` (Emscripten):**
- `RC2/src/dp.h`: copiar quase literalmente (`rc::Tree`, `DpScratch`, `dp_column`, `s_to`, `s_from`).
- `RC2/src/dp_mult.cpp`, `loo.cpp`, `bounded.cpp`:
  - extrair o corpo de `operator()` de cada Worker para uma função pura sobre `std::vector`/ponteiros;
  - trocar `parallelFor` por um loop serial;
  - preservar exatamente a ordem de soma (o comentário em `bounded.cpp` diz que ela foi escolhida para bater com o rc nos empates de threshold).
- `bounded.cpp:58-59`: trocar `R::pnorm(D,0,sd,lower=0)` por `0.5*std::erfc(D/(sd*M_SQRT2))` e verificar a paridade.
- `RC2/src/topology.cpp`: trocar `NA_INTEGER` por um sentinela -1 e `stop()` por exceção ou código de erro.
- `bindings.cpp`: embind expondo funções que recebem e devolvem `Float64Array`/`Int32Array` (sem cópias desnecessárias, via `typed_memory_view`).

**R → `src/engine/*.ts`:**
- `RC2/R/network.R:31` (`rc_network`): validação e chamada da topologia.
- `RC2/R/spec.R` (`rc_connectivity`, `rc_dispersal_*`, linhas 19 e 109-125): objetos de especificação.
- `RC2/R/index.R:66` (`rc_index`):
  - setup de fatores e custos em `:147-195`;
  - despacho `pair_sums` em `:186-195` (kernel multiplicativo → dp_mult; threshold e leptokurtic → bounded);
  - `cafi_index` em `:201`.
- `RC2/R/dindex.R:40` (`rc_dindex`):
  - LOO multiplicativo em `:75`;
  - forma fechada O(1) com `keep=TRUE` em `:86`;
  - kernels bounded em `:93`;
  - `sibling_delta` (barragens em confluência) em `:164`;
  - `barrier_scenarios` em `:200`.
- `RC2/R/checks.R`: checagens mostradas ao usuário num passo próprio.
- `RC2/R/convert.R:99,109`: `rc_set_weights`, `rc_set_passability`.

**SQL (DuckDB spatial) → `src/geo/*.sql.ts`:**
- Pipeline documentado em `RC2/R/geo.R:1-22`, nesta ordem:
  1. `rivers` (adapters `hydrorivers_v1` e `generic`)
  2. `basin` (opcional)
  3. `prune` (usa a Strahler do core)
  4. `merge_chains` (usa chains do core)
  5. `barriers`
  6. `snap`
  7. `split` (corte exato no ponto snapado)
  8. `attach` (opcional)
  9. `build`
- Leitura, CRS e UTM: `RC2/R/geo_duckdb.R` (`read_layer` em `:50-118`; zona UTM em `:192`; `ST_Transform ... always_xy` em `:200-204`; comprimento com `ST_Length_Spheroid(ST_FlipCoordinates())` em `:206`).
- Copiar as strings SQL de cada função `rc_geo_*`. Onde o R faz pós-processamento com dplyr, reescrever em SQL ou em TS.
- **Fora do v1:** a opção de comprimento `s2` (`RC2/R/geo.R:747`). Usar só a geodésica, que é o default.

**Defaults a respeitar (decisões fixas do rc2):**
- distância B = "rc" (custo da aresta = comprimento do trecho a montante); "midpoint" fica como opção;
- corte exato do trecho no ponto da barreira;
- cálculo por rede quando há múltiplos outlets.

## Resultados-ouro (paridade)
- **Script único `tools/make_golden.R`:** é o único uso de R, só em desenvolvimento e na máquina do Bruno. Ele roda o rc2 no Ebro e em `RC2/tests/testthat/fixtures/{ebro_tutorial,rc_random}.rds` e exporta JSON para `test/golden/`:
  - a saída de cada etapa geo (n° de trechos, comprimentos, ids após prune, merge, snap e split);
  - a rede final (nodes e edges);
  - índices DCI simétrico/assimétrico (full e reach), PCI exponencial 0.95 e weights múltiplos;
  - `rc_dindex` com os mesmos parâmetros da vignette `RC2/vignettes/rc2.Rmd:322-414`.
- **Comparação:** Vitest compara o engine (Node + o mesmo wasm) com os JSON com `toBeCloseTo`/tolerância 1e-10. Nunca igualdade exata.

## Fases
0. **Spike de 1 dia (go/no-go):** página mínima com duckdb-wasm + spatial carregando `ebro.gpkg` via `registerFileBuffer`. Validar:
   - `ST_Drivers()` contém GPKG;
   - `ST_Read(layer='rivers')` funciona;
   - `ST_Transform` para UTM e `ST_Length_Spheroid` funcionam;
   - `dp.h` compila com emcc e devolve um número.

   **Fallback se o GPKG falhar:** carregar a extensão `sqlite` do DuckDB e ler a geometria GPKG (WKB) com `ST_GeomFromWKB`. Ou então aceitar GeoParquet/GeoJSON como entrada.
1. **Core wasm + engine TS:** topologia, índices e dindex a partir da rede já pronta (golden `rc_random` e a rede do Ebro). A paridade numérica tem que passar antes de seguir.
2. **Pipeline geo no duckdb-wasm:** etapa por etapa contra o golden do Ebro (contagens e comprimentos com tolerância).
3. **UI wizard:**
   1. dados (upload ou botão "exemplo Ebro");
   2. rios + mapa;
   3. prune (slider `min_upland`/`min_order`);
   4. merge;
   5. barreiras + passabilidade + snap (`max_dist`);
   6. split;
   7. checks;
   8. índices (escolha de DCI/PCI, simétrico/assimétrico, dispersal);
   9. priorização (ranking + mapa colorido por dIndex);
   10. exportar CSV/GeoJSON.

   Cada passo mostra o resumo e o mapa da etapa.
4. **Pool de Workers para o LOO, barra de progresso e polimento.** Opcional: modo offline com PWA.

## Riscos e notas
- Regressões do duckdb-wasm spatial entre versões: fixar a versão e cachear os assets da extensão localmente (não depender do CDN em runtime).
- Peso: duckdb-wasm + spatial somam algo em torno de dezenas de MB no primeiro load. Aceitável, mas mostrar um loader.
- Licença HydroRIVERS do `ebro.gpkg`: verificar antes de hospedar publicamente com o exemplo embutido.
- Não publicar nem fazer deploy sem pedido explícito.

## Verificação
- `npm test`: Vitest com o golden em 1e-10 (core, engine e etapas geo).
- `npm run dev`: abrir no Chrome e no Firefox, rodar o exemplo Ebro do início ao fim e conferir que o ranking de priorização e o DCI batem com o golden mostrado na tela (modo debug).
- `npm run build && npx serve dist`: confirmar que o site estático funciona sem servidor e sem headers especiais.
