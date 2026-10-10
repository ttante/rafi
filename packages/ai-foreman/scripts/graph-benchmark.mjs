/** Offline deterministic bridge measurement. No agents, network or corpus scan. */
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { resolveGraphPython, runBridge } from "../dist/graph/bridge.js";
const python=await resolveGraphPython();
const resourceControls=(await runBridge(python,{action:"probe"})).resourceControls;
const samples=[];
for(const count of [10000,100000]){
  const graph={directed:true,multigraph:false,graph:{schema_version:1},nodes:Array.from({length:count},(_,i)=>({id:`n${i}`,label:`component${i}`,source_file:"fixture.py"})),links:Array.from({length:count-1},(_,i)=>({source:`n${i}`,target:`n${i+1}`,relation:"calls",confidence:"EXTRACTED",source_file:"fixture.py"}))};
  const durations=[];let returned=0;
  for(let sample=0;sample<5;sample++){
    const start=performance.now();
    const result=await runBridge(python,{action:"read",graph,operation:{operation:"neighbors",seeds:["n5000"],direction:"outgoing",depth:2}},{timeoutMs:15000});
    durations.push(performance.now()-start);returned=result.nodes.length;
    if(!result.nodes.some(n=>n.id==="n5002")||result.nodes.some(n=>n.id==="n4999"))throw new Error("Directed neighborhood correctness failed");
  }
  durations.sort((a,b)=>a-b);
  samples.push({nodes:count,edges:count-1,samples:durations.length,medianMs:durations[2],largestObservedMs:durations[4],returnedNodes:returned,mode:"cold one-shot subprocess",warmLatency:"not measured",semanticCost:"not applicable"});
}
console.log(JSON.stringify({schema:1,measuredAt:new Date().toISOString(),resourceControls,environment:{platform:platform(),release:release(),cpu:cpus()[0]?.model,node:process.version},samples,limits:"Five samples establish a local fixture observation, not a production percentile or agent-quality evaluation."},null,2));
