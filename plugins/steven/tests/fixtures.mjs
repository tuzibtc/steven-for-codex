import { digest } from '../scripts/lib/state.mjs';
export function sample() {
  return {schemaVersion:'3',projectId:'demo',revision:0,currentIterationId:'v1',sourceDemands:[{
    sourceDemandId:'s1',initialPriority:{p:'P1',d:'D1'},github:{repositoryId:'repo',projectId:'project',issueId:'issue',projectItemId:'item',url:'https://example.invalid/1'},
  }],projectDemands:[{projectDemandId:'d1',sourceDemandId:'s1',iterationId:'v1',prdId:'p1',priority:{p:'P1',d:'D1'},business:{status:'开发中',currentFlow:'技术开发'}}],
  prds:{p1:{iterationId:'v1',path:'PRD.md',lifecycle:'定稿',contentDigest:digest('基线'),effective:true,approvalReference:'user:p1',evidence:{remoteCommit:'a'.repeat(40),remoteDigest:digest('基线'),projectionsVerified:true,readBackAt:'2030-01-01'}}},
  iterations:{v1:{baselineIterationId:null,prdIds:['p1'],currentPrdId:'p1',draftPrdId:null,scope:{approvalReference:'user:scope',demandIds:['d1']},development:{status:'active',approvalReference:'user:develop',technicalPlanApprovalReference:'user:plan'}}},
  lastOperation:{operationId:'op0',status:'completed'}};
}
