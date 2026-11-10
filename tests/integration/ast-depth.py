"""Exercise static adapter patterns and polyglot symbol selection through real stdio.

No framework applications are executed. The ledger retains each observed response.
"""
import sys, json, subprocess, tempfile, hashlib, argparse, sqlite3
from pathlib import Path
sys.dont_write_bytecode = True
project = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--binary', required=True)
parser.add_argument('--output', default='/tmp/septum-ast-mcp-runtime.json')
args = parser.parse_args()
binary = Path(args.binary).resolve()
sys.path.insert(0, str(project/'tests/integration'))
from mcp_fixture import McpSession
fixtures = json.loads(subprocess.run(['bun','--eval', "import {sliceIntegrityCases} from './tests/fixtures/slice-integrity-cases.ts'; console.log(JSON.stringify(sliceIntegrityCases));"], cwd=project, check=True, capture_output=True, text=True).stdout)
report={'scope':'controlled stdio; static patterns only; no framework application execution', 'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(), 'runs':{}}
symbols = [
    ('typescript', 'orders.ts', 'export namespace Billing { export class Order { save() {} } }', 'Billing::Order::save'),
    ('php','orders.php','<?php class Order { public function __construct(private Service $svc) {} }','Order::$svc'),
    ('python','orders.py','class Order:\n    def save(self):\n        from .service import checkout\n        return checkout()\n','Order::save'),
    ('csharp','Orders.cs','namespace Sales { public class Order { public void Save() {} } }','Sales.Order.Save'),
    ('java','Orders.java','import java.util.*; class Orders { record Item(int id) {} }','Orders.Item'),
    ('ruby','orders.rb','require_relative("./model")\nclass Order\n def save\n end\nend','Order#save'),
    ('rust','orders.rs','use crate::orders::{Order, Repo as Storage}; pub fn save() {}','save'),
]
python_routes = {
    'fastapi': 'app = FastAPI()\nrouter = APIRouter(prefix=prefix)\n@router.get("/unknown")\ndef unknown(): pass\n',
    'flask': 'app = Flask(__name__)\nrouter = Blueprint("router", __name__, url_prefix=prefix)\n@router.route("/unknown")\ndef unknown(): pass\n',
    'django': '',
}
for framework in python_routes:
    for name, expression in [('dynamic', 'f"/orders/{kind}"'), ('bytes_path', 'b"/bytes"'), ('static_path', '"/sta" "tic"'), ('escaped_path', r'"/esc\x61ped"')]:
        if framework == 'django':
            python_routes[framework] += f'@api_view(["GET"])\ndef {name}(request): pass\n'
        else:
            decorator = 'get' if framework == 'fastapi' else 'route'
            python_routes[framework] += f'@app.{decorator}({expression})\ndef {name}(): pass\n'
python_routes['django'] += r'urlpatterns = [path(f"/orders/{kind}", dynamic), path(b"/bytes", bytes_path), path("/sta" "tic", static_path), path("/esc\x61ped", escaped_path)]'
with tempfile.TemporaryDirectory(prefix='septum-ast-runtime-') as tmp:
    for mode,command in {'source':['bun','run',str(project/'bin/septum.ts')], 'compiled':[str(binary)]}.items():
        report['runs'][mode]=[]
        for i,fixture in enumerate(fixtures):
            root=Path(tmp)/mode/f'adapter-{i}'
            root.mkdir(parents=True)
            framework=fixture['framework']
            manifest={}
            if framework in ['nestjs','express','fastify','hono','elysia']:
                manifest={'package.json':json.dumps({'dependencies':{'@nestjs/core' if framework=='nestjs' else framework:'*'}})}
            elif framework in ['fastapi','django','flask']: manifest={'requirements.txt':framework+'\n'}
            elif fixture['adapter']=='golang': manifest={'go.mod':'module fixture\n\ngo 1.22\n'}
            elif framework=='laravel': manifest={'artisan':'<?php\n','composer.json':json.dumps({'require':{'laravel/framework':'*'},'autoload':{'psr-4':{'App\\':'app/'}}})}
            elif framework=='symfony': manifest={'composer.json':json.dumps({'require':{'symfony/framework-bundle':'*'}})}
            for file,source in {**manifest,**fixture['files']}.items():
                path=root/file
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_text(source)
            with McpSession(command,root) as client:
                client.tool('septum_map',{'action':'register','domain':'root','root':'.','ingest_now':True})
                query='orders' if framework in ['cli','mcp-server'] else 'GET /orders'
                result=client.tool('septum_slice',{'query':query})
                assert result['status']=='success', (mode,framework,result)
                assert result['chain'],(mode,framework,result)
                report['runs'][mode].append({'kind':'adapter','framework':framework,'query':query,'response':result})
                print(mode, framework, 'PASS',flush=True)
        for language,file,source,query in symbols:
            root=Path(tmp)/mode/language
            root.mkdir(parents=True)
            (root/file).write_text(source)
            with McpSession(command,root) as client:
                client.tool('septum_map',{'action':'register','domain':'root','root':'.','ingest_now':True})
                located=client.tool('septum_symbol',{'action':'locate','query':query,'file_path':file})
                assert located['found'],(mode,language,located)
                assert located['symbol_ref']['name']==query,(mode,language,located)
                inspected=client.tool('septum_symbol',{'action':'inspect','symbol_ref':located['symbol_ref'],'include_source':True})
                assert inspected.get('symbol_ref')==located['symbol_ref'],(mode,language,inspected)
                assert inspected['source_slice']['status']=='current',(mode,language,inspected)
                with sqlite3.connect(f'file:{root / ".septum/septum.db"}?mode=ro', uri=True) as db:
                    dependencies = [row[0] for row in db.execute('SELECT target_symbol_or_path FROM dependencies ORDER BY id')]
                expected_dependencies = {'python':['.service'], 'java':['java.util.*'], 'ruby':['./model'], 'rust':['crate::orders::Order','crate::orders::Repo']}
                if language in expected_dependencies:
                    assert dependencies == expected_dependencies[language], (mode,language,dependencies)
                report['runs'][mode].append({'kind':'symbol','language':language,'query':query,'locate':located,'inspect':inspected,'dependencies':dependencies})
                print(mode,language,'symbol PASS',flush=True)
        for framework,source in python_routes.items():
            root=Path(tmp)/mode/f'negative-{framework}'
            root.mkdir(parents=True)
            (root/'requirements.txt').write_text(framework+'\n')
            (root/'urls.py').write_text(source)
            with McpSession(command,root) as client:
                client.tool('septum_map',{'action':'register','domain':'root','root':'.','ingest_now':True})
                with sqlite3.connect(f'file:{root / ".septum/septum.db"}?mode=ro', uri=True) as db:
                    routes=[row[0] for row in db.execute('SELECT route_uri FROM vertical_slices ORDER BY route_uri')]
                assert routes == ['/escaped','/static'], (mode,framework,routes)
                responses=[]
                for query in ['GET /static','GET /escaped']:
                    result=client.tool('septum_slice',{'query':query})
                    assert result['status']=='success', (mode,framework,result)
                    responses.append(result)
                report['runs'][mode].append({'kind':'python-route-controls','framework':framework,'routes':routes,'responses':responses})
                print(mode,framework,'route controls PASS',flush=True)
Path(args.output).write_text(json.dumps(report,indent=2))
print('PASS',sum(len(x) for x in report['runs'].values()), 'cases',flush=True)

