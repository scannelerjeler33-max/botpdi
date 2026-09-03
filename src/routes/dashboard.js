const express = require('express');
const router = express.Router();
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL || 'https://tu-url.supabase.co', 
    process.env.SUPABASE_ANON_KEY || 'tu-anon-key'
);

const adminRoles = process.env.ADMIN_ROLES ? process.env.ADMIN_ROLES.split(',') : [];
const userRoles = process.env.USER_ROLES ? process.env.USER_ROLES.split(',') : [];
const guildId = process.env.GUILD_ID;

// Configuración de multer para guardar temporalmente en memoria
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Middleware para verificar autenticación
function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/');
}

// Middleware para obtener roles del usuario en el servidor usando el bot
async function fetchUserRoles(req, res, next) {
    if (!guildId) {
        console.error("GUILD_ID no está configurado en .env");
        req.userRoles = [];
        return next();
    }
    
    try {
        const guild = await req.discordClient.guilds.fetch(guildId);
        if (!guild) throw new Error("Servidor no encontrado");
        
        const member = await guild.members.fetch(req.user.id);
        req.userRoles = member.roles.cache.map(role => role.id);
    } catch (err) {
        console.error("Error al obtener roles:", err);
        req.userRoles = [];
    }
    next();
}

router.use(checkAuth);
router.use(fetchUserRoles);

router.get('/', (req, res) => {
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    const isUser = req.userRoles.some(role => userRoles.includes(role));

    if (isAdmin) {
        return res.redirect('/dashboard/admin');
    } else if (isUser) {
        return res.redirect('/dashboard/user');
    } else {
        return res.render('no_access', { user: req.user });
    }
});

// Panel Admin
router.get('/admin', async (req, res) => {
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    if (!isAdmin) return res.status(403).send("No tienes permisos de administrador.");

    const missions = await prisma.mission.findMany({ orderBy: { createdAt: 'desc' } });
    const proofs = await prisma.proof.findMany({
        include: { mission: true },
        orderBy: { createdAt: 'desc' }
    });

    // Casos activos
    const activeCases = await prisma.activeCase.findMany({ where: { closed: false } });
    const enrichedCases = [];
    
    let channel;
    try {
        channel = await req.discordClient.channels.fetch('1519518326093774868');
    } catch(e) {}
    
    const guild = req.discordClient.guilds.cache.get(process.env.GUILD_ID);

    for (const c of activeCases) {
        let title = `Hilo ID: ${c.threadId}`;
        let username = `ID: ${c.userId}`;
        if (channel) {
            try {
                const thread = await channel.threads.fetch(c.threadId);
                if (thread) title = thread.name;
            } catch(e) {}
        }
        if (guild) {
            try {
                const member = await guild.members.fetch(c.userId);
                if (member) username = member.user.username;
            } catch(e) {}
        }
        enrichedCases.push({ ...c, title, username });
    }

    res.render('admin', { user: req.user, missions, proofs, activeCases: enrichedCases });
});

router.post('/admin/missions', async (req, res) => {
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    if (!isAdmin) return res.status(403).send("No autorizado.");

    const { title, description, requiredProofs } = req.body;
    
    try {
        const mission = await prisma.mission.create({
            data: {
                title,
                description,
                requiredProofs: parseInt(requiredProofs) || 1
            }
        });

        // Enviar notificación a Discord (Canal 1532199059094376648)
        const channelId = '1532199059094376648';
        const discordChannel = await req.discordClient.channels.fetch(channelId).catch(() => null);
        
        if (discordChannel) {
            const { EmbedBuilder } = require('discord.js');
            // Sacar la URL base usando la variable configurada
            const baseUrl = process.env.DISCORD_CALLBACK_URL 
                ? new URL(process.env.DISCORD_CALLBACK_URL).origin 
                : `http://${req.get('host')}`;
            const dashboardUrl = `${baseUrl}/dashboard/user`;
            
            const embed = new EmbedBuilder()
                .setTitle('🚨 ¡Nueva Misión Disponible!')
                .setDescription(`**${mission.title}**\n\n${mission.description}\n\n**Pruebas Requeridas:** ${mission.requiredProofs}`)
                .setColor(0x9b59b6) // Color morado
                .addFields({ name: 'Acción', value: `👉 [Entra aquí para subir tus pruebas](${dashboardUrl})` })
                .setTimestamp();

            await discordChannel.send({ 
                content: '<@&1519516475688357958>', 
                embeds: [embed] 
            }).catch(console.error);
        }
    } catch (err) {
        console.error("Error al crear la misión:", err);
    }
    
    res.redirect('/dashboard/admin');
});

router.post('/admin/missions/delete/:id', async (req, res) => {
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    if (!isAdmin) return res.status(403).send("No autorizado.");

    const id = parseInt(req.params.id);
    // Eliminar pruebas de esta misión primero para evitar error de llave foránea
    await prisma.proof.deleteMany({ where: { missionId: id } });
    await prisma.mission.delete({ where: { id } });
    res.redirect('/dashboard/admin');
});

router.post('/admin/casos/close/:id', async (req, res) => {
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    if (!isAdmin) return res.status(403).send("No autorizado.");

    const caseId = parseInt(req.params.id);
    const caso = await prisma.activeCase.findUnique({ where: { id: caseId } });
    
    if (!caso || caso.closed) return res.redirect('/dashboard/admin');

    try {
        const guildId = process.env.GUILD_ID;
        const guild = req.discordClient.guilds.cache.get(guildId);
        if (guild) {
            const member = await guild.members.fetch(caso.userId).catch(() => null);
            if (member) {
                await member.roles.remove(caso.roleId).catch(console.error);
            }
        }

        const channel = await req.discordClient.channels.fetch('1519518326093774868').catch(() => null);
        if (channel) {
            const thread = await channel.threads.fetch(caso.threadId).catch(() => null);
            if (thread && !thread.archived) {
                await thread.edit({ name: `[CERRADO] ${thread.name}` }).catch(console.error);
            }
        }

        await prisma.activeCase.update({
            where: { id: caso.id },
            data: { closed: true }
        });
    } catch (err) {
        console.error("Error al cerrar el caso manualmente:", err);
    }

    res.redirect('/dashboard/admin');
});

router.post('/admin/aviso-interviewer', async (req, res) => {
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    if (!isAdmin) return res.status(403).send("No autorizado.");

    const channelId = '1364055075684618434';
    const discordChannel = await req.discordClient.channels.fetch(channelId).catch(() => null);

    if (discordChannel) {
        const text = `# 📢 POSTULACIONES ABIERTAS — INTERVIEWER | PFA

Se encuentran abiertas las postulaciones para Interviewer.

📌 Requisito: rango mínimo Sargento Mayor.

**🏆 TOP 1: La persona que más gente ingrese a la PFA se llevará 1 Promote + 3 Coins.**

📋 ¿Qué buscamos?

• Ser constante, preciso y paciente durante los exámenes.
• Evitar trampas sin facilitar el examen al punto de bypassearlo.
• Atender tickets de dudas y reportes con respeto y buena actitud.
• Ser constante en las oposiciones y dar el ejemplo a los nuevos.
• Asegurar que los pfa sigan las normativas y en caso de que no, sacar evidencia y sancionarlos

⭐ Beneficios: Ser Interviewer te da la posibilidad de ser **Ayudante Head** y, con buen desempeño IC/OOC y constancia, **ser considerado para un futuro puesto de Head.**

<@&1393678701408817284>`;
        
        await discordChannel.send({ content: text }).catch(console.error);
    }
    
    res.redirect('/dashboard/admin');
});

// --- POSTULACIONES INTERVIEWER ---
const POSTULACION_ROLE = '1393678701408817284';

router.get('/user/postulacion', async (req, res) => {
    const hasRole = req.userRoles.includes(POSTULACION_ROLE);
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    
    if (!hasRole && !isAdmin) {
        return res.render('no_access', { user: req.user, message: "No tienes el rango mínimo requerido (Sargento Mayor) para postularte a Interviewer." });
    }
    
    res.render('postulacion', { user: req.user });
});

router.post('/user/postulacion', async (req, res) => {
    const hasRole = req.userRoles.includes(POSTULACION_ROLE);
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    
    if (!hasRole && !isAdmin) return res.status(403).send("No autorizado.");

    const { 
        nombrePlaca, rango, antiguedad, edadOoc, disponibilidad,
        q1, q2, q3, q4, q5, q6, q7 
    } = req.body;

    try {
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        
        const embed1 = new EmbedBuilder()
            .setTitle(`📝 Postulación Interviewer - ${nombrePlaca}`)
            .setColor(0x3498db)
            .addFields(
                { name: '👤 Datos Personales', value: `**Rango:** ${rango}\n**Antigüedad:** ${antiguedad}\n**Edad OOC:** ${edadOoc}\n**Disponibilidad:** ${disponibilidad}` },
                { name: '1) Prioridad en oposición', value: String(q1).substring(0, 1024) },
                { name: '2) Qué hacer y NO hacer', value: String(q2).substring(0, 1024) },
                { name: '3) Falta leve y grave', value: String(q3).substring(0, 1024) },
                { name: '4) Comportamiento', value: String(q4).substring(0, 1024) }
            );

        const embed2 = new EmbedBuilder()
            .setColor(0x3498db)
            .addFields(
                { name: '5) Error sin mala intención', value: String(q5).substring(0, 1024) },
                { name: '6) Peligro: no sancionar vs sancionar mal', value: String(q6).substring(0, 1024) },
                { name: '7) Criterio personal', value: String(q7).substring(0, 1024) }
            )
            .setFooter({ text: `Discord ID: ${req.user.id} | User: ${req.user.username}` })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`accept_int_${req.user.id}`)
                .setLabel('✅ Aceptar')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`reject_int_${req.user.id}`)
                .setLabel('❌ Rechazar')
                .setStyle(ButtonStyle.Danger)
        );

        // Nuevo canal proporcionado por el usuario
        const channelId = '1526485176698540072'; 
        const discordChannel = await req.discordClient.channels.fetch(channelId).catch(() => null);
        
        if (discordChannel) {
            await discordChannel.send({ embeds: [embed1, embed2], components: [row] }).catch(console.error);
        }
    } catch (err) {
        console.error("Error al procesar la postulación:", err);
    }

    res.redirect('/dashboard/user');
});

// Panel Usuario
router.get('/user', async (req, res) => {
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    const isUser = req.userRoles.some(role => userRoles.includes(role));
    const canPostular = req.userRoles.includes(POSTULACION_ROLE) || isAdmin;

    // Si no es admin, no es usuario y no puede postularse -> Sin acceso
    if (!isUser && !isAdmin && !canPostular) {
        return res.render('no_access', { user: req.user });
    }

    const isOnlyPostulante = !isUser && !isAdmin && canPostular;

    let missions = [];
    let completedMissions = {};
    let proofCounts = {};
    let topLeaderboard = [];

    // Solo consultar misiones y ranking si tiene rol PDI o Admin
    if (!isOnlyPostulante) {
        missions = await prisma.mission.findMany({ orderBy: { createdAt: 'desc' } });
        
        const userProofs = await prisma.proof.findMany({
            where: { userId: req.user.id }
        });

        userProofs.forEach(p => {
            if (!proofCounts[p.missionId]) proofCounts[p.missionId] = 0;
            proofCounts[p.missionId]++;
        });

        missions.forEach(m => {
            const count = proofCounts[m.id] || 0;
            if (count >= m.requiredProofs) {
                completedMissions[m.id] = true;
            }
        });

        const allProofs = await prisma.proof.findMany();
        const userStats = {};
        allProofs.forEach(p => {
            if (!userStats[p.userId]) {
                userStats[p.userId] = { username: p.username, missionCounts: {} };
            }
            if (!userStats[p.userId].missionCounts[p.missionId]) {
                userStats[p.userId].missionCounts[p.missionId] = 0;
            }
            userStats[p.userId].missionCounts[p.missionId]++;
        });

        const leaderboard = [];
        for (const userId in userStats) {
            const stats = userStats[userId];
            let completedCount = 0;
            for (const missionId in stats.missionCounts) {
                const count = stats.missionCounts[missionId];
                const mission = missions.find(m => m.id === parseInt(missionId));
                if (mission && count >= mission.requiredProofs) {
                    completedCount++;
                }
            }
            if (completedCount > 0) {
                leaderboard.push({ username: stats.username, completedCount });
            }
        }
        
        leaderboard.sort((a, b) => b.completedCount - a.completedCount);
        topLeaderboard = leaderboard.slice(0, 5);
    }

    res.render('user', { user: req.user, missions, completedMissions, proofCounts, isAdmin, topLeaderboard, canPostular, isOnlyPostulante });
});

router.post('/user/upload', upload.single('proofImage'), async (req, res) => {
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    const isUser = req.userRoles.some(role => userRoles.includes(role));
    if (!isUser && !isAdmin) return res.status(403).send("No autorizado.");

    const missionId = parseInt(req.body.missionId);
    if (!req.file) return res.status(400).send("Falta la imagen.");

    const originalName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '');
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}-${originalName}`;

    // Subir a Supabase Storage
    const { data, error } = await supabase
        .storage
        .from('proofs') // Asumimos que el bucket se llama 'proofs'
        .upload(fileName, req.file.buffer, {
            contentType: req.file.mimetype
        });

    if (error) {
        console.error("Error subiendo imagen a Supabase:", error);
        return res.status(500).send("Hubo un error al subir la imagen. Verifica la configuración de Supabase.");
    }

    // Obtener URL pública
    const { data: publicUrlData } = supabase.storage.from('proofs').getPublicUrl(fileName);
    const imageUrl = publicUrlData.publicUrl;

    await prisma.proof.create({
        data: {
            missionId,
            userId: req.user.id,
            username: req.user.username,
            imageUrl
        }
    });

    res.redirect('/dashboard/user');
});

router.post('/user/caso', async (req, res) => {
    const isAdmin = req.userRoles.some(role => adminRoles.includes(role));
    const isUser = req.userRoles.some(role => userRoles.includes(role));
    if (!isUser && !isAdmin) return res.status(403).send("No autorizado.");

    const { numeroCaso, nombreMafia, descripcionCaso } = req.body;
    
    try {
        const channel = await req.discordClient.channels.fetch('1519518326093774868');
        const roleId = '1541559243185070130';
        const guildId = process.env.GUILD_ID;
        
        if (channel) {
            const thread = await channel.threads.create({
                name: `CASO # ${numeroCaso} - ${nombreMafia.toUpperCase()}`,
                message: {
                    content: `**Caso reportado por:** <@${req.user.id}>\n\n**Descripción:**\n${descripcionCaso}`
                }
            });

            // Asignar rol al usuario
            const guild = req.discordClient.guilds.cache.get(guildId);
            if (guild) {
                const member = await guild.members.fetch(req.user.id);
                if (member) {
                    await member.roles.add(roleId).catch(console.error);
                }
            }

            // Calcular fecha de expiración (1 semana)
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 7);

            // Guardar en la base de datos
            await prisma.activeCase.create({
                data: {
                    userId: req.user.id,
                    threadId: thread.id,
                    roleId: roleId,
                    expiresAt: expiresAt
                }
            });
        }
    } catch (error) {
        console.error("Error al crear el caso en Discord:", error);
    }

    res.redirect('/dashboard/user');
});

module.exports = router;
