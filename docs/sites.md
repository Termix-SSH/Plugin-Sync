A Termix server can manage other Termix servers as remote sites, for example one at home and one at work. The master lists each site's hosts and status, rolls up their health and opens sessions on their hosts. The remote server does the connecting. The master only passes the terminal along.

## Set it up

1. On the remote server, go to your API key settings and make a key. Use a user that can see the hosts you want to manage.
2. On the master, open Sites in the rail and choose Add site.
3. Enter a name, the address of the remote server and the key.

The master reads the hosts and status right away, then again every minute.

## What you can do

- See every site, whether it answers, and how many of its hosts are online.
- Open a site to list its hosts. Hosts are read only here. Change them on the remote.
- Open a session on a host. The remote makes the SSH connection with the credentials it holds, so no secrets reach the master.
- If a host asks for a password, passphrase or code, the terminal asks you for it.

## Permissions

What you can see and open comes from the API key's user on the remote. A host that user can't connect to doesn't show up. Only users with the sites permission can use Sites on the master.

The API key is saved encrypted on the master and is only ever sent to its own remote. Deleting the key on the remote cuts the master off.

## Connecting sites that can't reach each other

Termix doesn't include a VPN. If the master can't reach a remote directly, connect them with the Tailscale or NetBird plugins, or any private network you already use, and use the private address as the site address.

## Requirements

The remote server must be on Termix 26.10.3 or newer, since that is the version that lets an API key open a terminal session.
