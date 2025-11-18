<script lang="ts">

 	import 'leaflet/dist/leaflet.css';
 

	let { children } = $props();
</script>

<svelte:head>

</svelte:head>

{@render children()}
