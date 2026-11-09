export const examples = [
  {
    name: "轻量操作按钮",
    slug: "quiet-actions",
    category: "按钮",
    framework: "react",
    description: "清晰的主次层级，带禁用、加载和危险操作状态。",
    tags: ["简洁", "后台"],
    source: "本站示例",
    license: "MIT",
    entry: "button.tsx",
    dependencies: {},
    files: [
      {
        path: "button.tsx",
        content: `import React from 'react';
export function Button({children='保存修改',variant='primary',loading=false,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string;loading?:boolean}){return <button {...props} disabled={props.disabled||loading} style={{border:'1px solid '+(variant==='primary'?'#18181b':'#ddd'),background:variant==='primary'?'#18181b':'#fff',color:variant==='primary'?'white':variant==='danger'?'#b42318':'#18181b',padding:'10px 18px',borderRadius:6,fontSize:14,cursor:'pointer',opacity:props.disabled?.5:1}}>{loading?'保存中…':children}</button>}`,
      },
    ],
    demo: `import {Button} from './button';export default function Demo(){return <div style={{display:'flex',flexWrap:'wrap',gap:12}}><Button/><Button variant="secondary">取消</Button><Button variant="danger">删除</Button><Button disabled>已归档</Button></div>}`,
  },
  {
    name: "紧凑数据表格",
    slug: "compact-table",
    category: "表格",
    framework: "react",
    description:
      "细行分隔、右对齐数字，点击列标题切换金额排序。数据为演示样例。",
    tags: ["后台", "紧凑"],
    source: "本站示例",
    license: "MIT",
    entry: "table.tsx",
    dependencies: {},
    files: [
      {
        path: "table.tsx",
        content: `import React,{useState} from 'react';
const rows=[{name:'组件目录',owner:'设计组',amount:1280,status:'已完成'},{name:'预览环境',owner:'研发组',amount:640,status:'进行中'},{name:'导出工具',owner:'研发组',amount:960,status:'待验收'}];
export default function DataTable(){const[asc,setAsc]=useState(true);return <table style={{borderCollapse:'collapse',width:'100%',fontSize:14,textAlign:'left'}}><thead><tr>{['项目','负责人','金额（元）','状态'].map((title,i)=><th key={title} style={{padding:'12px',borderBottom:'1px solid #ddd',color:'#666',fontWeight:400,textAlign:i===2?'right':'left'}}>{i===2?<button onClick={()=>setAsc(!asc)} style={{background:'none',border:0,cursor:'pointer'}}>金额 {asc?'↑':'↓'}</button>:title}</th>)}</tr></thead><tbody>{[...rows].sort((a,b)=>asc?a.amount-b.amount:b.amount-a.amount).map(row=><tr key={row.name}>{[row.name,row.owner,row.amount.toLocaleString(),row.status].map((cell,i)=><td key={i} style={{padding:'16px 12px',borderBottom:'1px solid #eee',textAlign:i===2?'right':'left',fontVariantNumeric:'tabular-nums'}}>{cell}</td>)}</tr>)}</tbody></table>}`,
      },
    ],
    demo: "",
  },
  {
    name: "页码分页",
    slug: "page-navigation",
    category: "分页",
    framework: "react",
    description: "受控分页的轻量示例，包含首尾页边界和当前页状态。",
    tags: ["简洁", "后台"],
    source: "本站示例",
    license: "MIT",
    entry: "pagination.tsx",
    dependencies: {},
    files: [
      {
        path: "pagination.tsx",
        content: `import React,{useState} from 'react';
export default function Pagination(){const[page,setPage]=useState(1);return <nav aria-label="示例分页" style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:16,flexWrap:'wrap',fontSize:14}}><span style={{color:'#666'}}>共 50 条 · 第 {page} / 5 页</span><div style={{display:'flex',gap:6}}>{['上一页',1,2,3,4,5,'下一页'].map((item,i)=><button key={item} disabled={i===0&&page===1||i===6&&page===5} aria-current={item===page?'page':undefined} onClick={()=>setPage(i===0?page-1:i===6?page+1:Number(item))} style={{padding:'8px 12px',border:'1px solid #ddd',borderRadius:5,background:item===page?'#18181b':'white',color:item===page?'white':'#333',opacity:(i===0&&page===1||i===6&&page===5)?.4:1,cursor:'pointer'}}>{item}</button>)}</div></nav>}`,
      },
    ],
    demo: "",
  },
  {
    name: "订阅输入框",
    slug: "inline-subscribe",
    category: "表单",
    framework: "html",
    description: "HTML / CSS 组件，支持原生邮箱校验。提交仅更新本地演示状态。",
    tags: ["网站", "轻量"],
    source: "本站示例",
    license: "MIT",
    entry: "index.html",
    dependencies: {},
    files: [
      {
        path: "index.html",
        content:
          '<form onsubmit="event.preventDefault();this.querySelector(\'button\').textContent=\'已提交\'"><label for="email">获取更新</label><p>组件发布后，第一时间了解。</p><div><input id="email" required type="email" placeholder="你的邮箱地址"/><button>订阅更新</button></div></form>',
      },
      {
        path: "style.css",
        content:
          "form{max-width:480px;margin:auto}label{font-weight:600;font-size:20px}p{color:#666;margin:10px 0 24px}form div{display:flex;gap:8px}input{min-width:0;flex:1;border:1px solid #ddd;padding:12px;border-radius:6px;font:inherit}button{background:#18181b;border:0;color:white;padding:12px 18px;border-radius:6px;font:inherit;cursor:pointer}",
      },
    ],
    demo: "",
  },
]
