import {render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import {BudgetResults,CardResults} from '../Results';
import {ArtifactPreview,artifactTitle} from '../ChatArtifacts';
import type {Result} from '../contracts';
const source={url:'https://example.com/card',title:'Synthetic card guide',retrieved_at:'2026-11-13T00:00:00Z'};
const card={card_id:'xy-1',name:'Gardevoir ex',quantity:1,set_name:'Synthetic',number:'1',condition:'Near Mint',language:'English',printing:'any'};
const result:Result={plan:{purpose:'collection',format:'collection',cards:[card],sources:[source],explanation:'Research a collection.'},legality:{status:'unverified',applicable:false,issues:[],sources:[]},offers:[],budgets:[],missing:[],supplier_errors:[],recommendation:'Selected a researched collection.',collection_summary:{status:'selected',subject:'Gardevoir',budget_amount:'150000',currency:'JPY',product_subtotal:'2850',remaining_budget:'147150',selected_printings:1,researched_candidates:3,preferred_selected:1,limitations:['Stock and shipping unverified.'],lines:[{card_id:'xy-1',name:'Gardevoir ex',set_name:'Synthetic',number:'1',supplier:'Cardmarket',original_currency:'EUR',original_line_total:'18',converted_line_total:'2850',source}],excluded_candidates:[{card_id:'x-2',name:'Another printing',reason:'Would exceed the remaining product budget.'}]}};
it('shows a collection budget, original prices and remaining allowance without a tournament warning',()=>{
 render(<BudgetResults result={result}/>);
 expect(screen.getByRole('heading',{name:'Collection budget'})).toBeInTheDocument();
 expect(screen.getByText('150000 JPY')).toBeInTheDocument();
 expect(screen.getAllByText('2850 JPY').length).toBeGreaterThan(0);
 expect(screen.getByText('147150 JPY')).toBeInTheDocument();
 expect(screen.getByText('Original: 18 EUR')).toBeInTheDocument();
 expect(screen.getByRole('rowheader',{name:/Gardevoir ex Synthetic · #1/})).toBeInTheDocument();
 expect(screen.getByRole('tab',{name:'Collection'})).toBeInTheDocument();
 expect(screen.queryByText('Estimated deck cost')).not.toBeInTheDocument();
});
it('uses collection language in previews and card lists while leaving deck labels alone',()=>{
 const artifact={id:'collection',kind:'budget' as const,result};
 expect(artifactTitle(artifact)).toBe('Collection and budget');
 const preview=render(<ArtifactPreview artifact={artifact} onOpen={()=>{}}/>);
 expect(screen.getByText('Collection estimate: 2850 JPY')).toBeInTheDocument();
 expect(screen.getByText('Collection · play legality not required')).toBeInTheDocument();
 preview.unmount();render(<CardResults cards={[card]} legality={result.legality}/>);
 expect(screen.getByRole('heading',{name:/Collection cards/})).toBeInTheDocument();
 expect(screen.getByText('Collectible printings · tournament legality not required')).toBeInTheDocument();
});
it('distinguishes unverified seller availability from missing price quotations',()=>{
 const missing={...card,covered:0,reason:'Availability unverified'};
 const preview=render(<ArtifactPreview artifact={{id:'stock-unknown',kind:'budget',result:{...result,missing:[missing],availability_unverified:[missing]}}} onOpen={()=>{}}/>);
 expect(screen.getByText(/1 card with unverified seller availability/)).toBeInTheDocument();
 expect(screen.queryByText(/without quotations/)).not.toBeInTheDocument();
 preview.unmount();
 render(<ArtifactPreview artifact={{id:'stock-shortfall',kind:'budget',result:{...result,missing:[missing],stock_shortages:[missing]}}} onOpen={()=>{}}/>);
 expect(screen.getByText(/1 card with confirmed listing shortfalls/)).toBeInTheDocument();
 expect(screen.queryByText(/unverified seller availability/)).not.toBeInTheDocument();
});
