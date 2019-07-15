# KyokoMesh
Write grpc microservices in typescript. Just for fun, Don't use.

Note: Installing grpc over proxy may fail beacuse of `needle` issue. Add the following line to your `.npmrc` file
```
grpc_node_binary_host_mirror=https://npm.taobao.org/mirrors
```

## Example
api.ts
```typescript
// define your async functions as service here, a default keyword is required
export default {
    async hello() {
        // you can use `this` to reference other async functions
        return 'my ' + await this.faas.server()
    },
    faas: {
        // async functions within objects are supported
        async server() {
            return 'FAAS'
        },
    },
    async *stream() {
        for (let i = 0; i < 10; i ++) {
            await new Promise(resolve => setTimeout(resolve, 100))
            yield i
        }
    },
}
```

server
```bash
kykm serve api.ts
# outputs: serving "9316dc36" with 3 entries at 0.0.0.0:62967
```

client
```bash
kykm call hello
# outputs: my FAAS
```

demo.ts
```typescript
import Mesh from 'kyoko-mesh'
import API from './api'

const api = new Mesh().query(API)
async function run() {
    for await (const item of api.stream()) {
        console.log(item)
    }
}
run()
```

## License
MIT
