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
    __filename, // add this line so that we can find this module and use grpc
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
}
```

main.ts
```typescript
import KyokoMesh from 'kyoko-mesh'
import API from './api'

async function start() {
    const server = new KyokoMesh({ }, API)
        client = new KyokoMesh()
    await Promise.all([server.init(), client.init()])

    const api = client.query(API)
    console.log('hello ' + await api.hello())
}

start()
```

## License
MIT
