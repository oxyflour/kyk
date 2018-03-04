# KyokoMesh
simple and stupid FAAS service mesh

## Example
```typescript
import KyokoMesh from 'kyoko-mesh'

// define your async functions as service here
const api = {
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

async function start() {
    const
        // server provide api
        server = new KyokoMesh({ }, api)
        // client use it with client.query(api)
        client = new KyokoMesh()
    await Promise.all([server, client].map(node => {
        return new Promise(resolve => node.once('ready', resolve))
    }))

    console.log('hello ' + await client.query(api).hello())
}

start()
```

## License
MIT
